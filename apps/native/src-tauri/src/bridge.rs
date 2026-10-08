use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex as AsyncMutex},
};

type Reply = oneshot::Sender<Result<Value, String>>;
type Publish = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// Owns exactly one backend. Losing either inherited pipe causes fail-closed cleanup.
pub struct Bridge {
    input: AsyncMutex<Option<ChildStdin>>,
    child: AsyncMutex<Child>,
    pending: Mutex<HashMap<u64, Reply>>,
    next_id: AtomicU64,
    alive: AtomicBool,
    pub status: Mutex<Value>,
}

pub fn stopped_status() -> Value {
    json!({"phase":"stopped","rpcReady":false,"feishuConnected":false,"pending":0,"error":null,"tasks":[]})
}

impl Bridge {
    pub async fn spawn(runtime: &Path, publish: Publish) -> Result<Arc<Self>, String> {
        let mut command = Command::new(runtime.join("node"));
        command
            .arg(runtime.join("backend/desktop/native-entry.js"))
            .current_dir(runtime)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .env_remove("ELECTRON_RUN_AS_NODE")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        // Do not kill the backend on Drop: EOF must interrupt owned tasks before its server exits.
        let mut child = command
            .spawn()
            .map_err(|_| "无法启动网关后端，请重新构建或安装完整 App".to_string())?;
        let input = child.stdin.take().ok_or("后端私有管道不可用")?;
        let output = child.stdout.take().ok_or("后端私有管道不可用")?;
        let bridge = Arc::new(Self {
            input: AsyncMutex::new(Some(input)),
            child: AsyncMutex::new(child),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            alive: AtomicBool::new(true),
            status: Mutex::new(stopped_status()),
        });
        let receiver = bridge.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(output);
            loop {
                // take() bounds a malformed backend frame before allocating arbitrary memory.
                let mut line = Vec::new();
                use tokio::io::AsyncReadExt;
                let size = (&mut reader)
                    .take(1024 * 1024 + 1)
                    .read_until(b'\n', &mut line)
                    .await;
                match size {
                    Ok(n) if n > 0 && n <= 1024 * 1024 && line.last() == Some(&b'\n') => {}
                    _ => break,
                }
                let Ok(message) = serde_json::from_slice::<Value>(&line) else {
                    break;
                };
                if let Some(event) = message["event"].as_str() {
                    if event == "status" {
                        *receiver.status.lock().unwrap() = message["value"].clone();
                        publish("desktop:status", message["value"].clone());
                    } else if event == "setup" {
                        publish("desktop:feishu-setup", message["value"].clone());
                    }
                } else if let Some(id) = message["id"].as_u64() {
                    if let Some(reply) = receiver.pending.lock().unwrap().remove(&id) {
                        let result = if message["ok"] == true {
                            Ok(message["value"].clone())
                        } else {
                            Err(message["error"]
                                .as_str()
                                .unwrap_or("后台操作失败")
                                .to_string())
                        };
                        let _ = reply.send(result);
                    }
                }
            }
            receiver.alive.store(false, Ordering::SeqCst);
            for (_, reply) in receiver.pending.lock().unwrap().drain() {
                let _ = reply.send(Err("后台进程已退出，请重新打开 App 并检查日志".into()));
            }
            let mut status = stopped_status();
            status["phase"] = json!("error");
            status["error"] = json!("后台进程已退出");
            *receiver.status.lock().unwrap() = status.clone();
            publish("desktop:status", status);
            // Close stdin too: a still-live malformed backend receives the same EOF cleanup.
            receiver.input.lock().await.take();
        });
        Ok(bridge)
    }

    pub async fn request(&self, method: &str, args: Value) -> Result<Value, String> {
        if !self.alive.load(Ordering::SeqCst) {
            return Err("后台进程未连接，请重新打开 App".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let mut bytes = serde_json::to_vec(&json!({"id":id,"method":method,"args":args}))
            .map_err(|_| "操作数据不可用")?;
        bytes.push(b'\n');
        let sent = {
            let mut input = self.input.lock().await;
            match input.as_mut() {
                Some(input) => input.write_all(&bytes).await.is_ok(),
                None => false,
            }
        };
        // The initialize frame can contain the storage key; discard its serialized copy.
        use zeroize::Zeroize;
        bytes.zeroize();
        if !sent {
            self.pending.lock().unwrap().remove(&id);
            return Err("无法连接后台进程".into());
        }
        let result = tokio::time::timeout(Duration::from_secs(130), rx).await;
        self.pending.lock().unwrap().remove(&id);
        match result {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("后台连接已关闭".into()),
            Err(_) => Err("操作仍未确认，请检查状态后重试；未自动重复执行".into()),
        }
    }

    pub async fn close(&self) -> Result<(), String> {
        if self.alive.load(Ordering::SeqCst) {
            self.request("shutdown", Value::Null).await?;
        }
        self.input.lock().await.take();
        let status = tokio::time::timeout(Duration::from_secs(15), self.child.lock().await.wait())
            .await
            .map_err(|_| "后端清理尚未确认，已保留窗口")?
            .map_err(|_| "无法确认后端退出状态")?;
        if !status.success() {
            return Err("后端清理失败，请核对日志及未决任务".into());
        }
        Ok(())
    }
}
