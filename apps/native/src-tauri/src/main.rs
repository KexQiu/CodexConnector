mod bridge;
mod login_item;
mod storage;

use bridge::Bridge;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

struct Host {
    bridge: Arc<Bridge>,
    root: PathBuf,
    closing: AtomicBool,
    approved: AtomicBool,
    flush: Mutex<Option<(String, oneshot::Sender<bool>)>>,
    smoke: bool,
}

fn console_url(url: &url::Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
        || (cfg!(debug_assertions)
            && url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port() == Some(1420))
}

fn local_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("非法界面来源".into());
    }
    let url = window.url().map_err(|_| "无法验证界面来源")?;
    if !console_url(&url) {
        return Err("非法界面来源".into());
    }
    Ok(())
}

async fn confirm_stop(app: &tauri::AppHandle, host: &Host) -> Result<(), String> {
    let status = host.bridge.request("status", Value::Null).await?;
    let pending = status["pending"].as_u64().unwrap_or(0);
    if pending == 0 {
        return Ok(());
    }
    let dialog = app.dialog().message(format!("还有 {pending} 个未完成任务。停止后将取消排队任务、中断飞书运行任务；未确认的任务保留待核对记录。Codex 桌面端独立任务继续运行。"))
        .title("停止飞书任务").kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("停止任务".into(), "继续运行".into()));
    let confirmed = tauri::async_runtime::spawn_blocking(move || dialog.blocking_show())
        .await
        .map_err(|_| "无法确认停止")?;
    if !confirmed {
        return Err("已取消停止，服务继续运行".into());
    }
    Ok(())
}

#[tauri::command]
async fn desktop_request(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: Value,
    host: tauri::State<'_, Host>,
) -> Result<Value, String> {
    local_window(&window)?;
    let method = request["method"].as_str().ok_or("操作格式不正确")?;
    let cache_operation = method == "saveDraft"
        || (method == "feishuSetup"
            && matches!(
                request["action"]["kind"].as_str(),
                Some("edit" | "suspend" | "cancel" | "load")
            ));
    if host.closing.load(Ordering::SeqCst) && !cache_operation {
        return Err("App 正在退出，请等待缓存保存和任务停止".into());
    }
    match method {
        "chooseDirectory" | "chooseCodex" => {
            let directory = method == "chooseDirectory";
            let picker = app.dialog().file().set_title(if directory {
                "选择项目目录"
            } else {
                "选择 Codex 可执行文件"
            });
            let selected = tauri::async_runtime::spawn_blocking(move || {
                if directory {
                    picker.blocking_pick_folder()
                } else {
                    picker.blocking_pick_file()
                }
            })
            .await
            .map_err(|_| "无法打开选择窗口")?;
            match selected {
                Some(path) => {
                    let path = path.into_path().map_err(|_| "请选择本机路径")?;
                    let path = if directory {
                        std::fs::canonicalize(path).map_err(|_| "项目目录不存在或不可访问")?
                    } else {
                        path
                    };
                    Ok(json!(path.to_str().ok_or("路径编码不可用")?))
                }
                None => Ok(Value::Null),
            }
        }
        "openData" => {
            app.opener()
                .open_path(host.root.to_string_lossy(), None::<&str>)
                .map_err(|_| "无法打开数据目录")?;
            Ok(Value::Null)
        }
        "copyDiagnostics" => {
            let summary = json!({"appVersion":env!("CARGO_PKG_VERSION"),"host":"rust/tauri","platform":std::env::consts::OS,"arch":std::env::consts::ARCH,"runtime":*host.bridge.status.lock().unwrap()});
            app.clipboard()
                .write_text(serde_json::to_string_pretty(&summary).unwrap())
                .map_err(|_| "无法写入剪贴板")?;
            Ok(Value::Null)
        }
        "openFeishu" | "copyFeishu" => {
            let effect = host.bridge.request("effect", request).await?;
            let value = effect["value"].as_str().ok_or("官方入口不可用")?;
            if effect["kind"] == "open" {
                storage::validate_official_url(value)?;
                app.opener()
                    .open_url(value, None::<&str>)
                    .map_err(|_| "无法打开官方入口")?;
            } else if effect["kind"] == "copy" {
                app.clipboard()
                    .write_text(value)
                    .map_err(|_| "无法写入剪贴板")?;
            } else {
                return Err("不支持的原生操作".into());
            }
            Ok(Value::Null)
        }
        "loginItem" => Ok(login_item::read(cfg!(debug_assertions) || host.smoke)),
        "setLoginItem" => login_item::set(
            request["enabled"].as_bool().ok_or("登录项格式不正确")?,
            cfg!(debug_assertions) || host.smoke,
        ),
        "stop" => {
            confirm_stop(&app, &host).await?;
            host.bridge.request("request", request).await
        }
        "load" | "saveDraft" | "apply" | "start" | "logs" | "feishuSetup" | "applyFeishuSetup"
        | "mergeFeishuSetup" | "checkCodex" | "checkProjectless" | "checkFeishu"
        | "discoverProjects" => host.bridge.request("request", request).await,
        _ => Err("不支持的界面操作".into()),
    }
}

#[tauri::command]
fn draft_flushed(
    window: tauri::WebviewWindow,
    host: tauri::State<'_, Host>,
    token: String,
    ok: bool,
) -> Result<(), String> {
    local_window(&window)?;
    let mut pending = host.flush.lock().unwrap();
    if pending
        .as_ref()
        .is_some_and(|(expected, _)| expected == &token)
    {
        if let Some((_, reply)) = pending.take() {
            let _ = reply.send(ok);
        }
    }
    Ok(())
}

async fn flush_draft(app: &tauri::AppHandle, host: &Host) -> Result<(), String> {
    let token = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    *host.flush.lock().unwrap() = Some((token.clone(), tx));
    if let Some(window) = app.get_webview_window("main") {
        window
            .emit("desktop:flush-draft", token)
            .map_err(|_| "无法确认本地缓存")?;
    } else {
        return Err("无法确认本地缓存，尚未退出".into());
    }
    let result = tokio::time::timeout(Duration::from_secs(15), rx).await;
    host.flush.lock().unwrap().take();
    if !matches!(result, Ok(Ok(true))) {
        return Err("未能确认本地缓存已保存，已保留窗口，请重试".into());
    }
    Ok(())
}

fn begin_quit(app: tauri::AppHandle) {
    let host = app.state::<Host>();
    if host.closing.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let host = app.state::<Host>();
        let finish = async {
            flush_draft(&app, &host).await?;
            confirm_stop(&app, &host).await?;
            host.bridge.close().await
        }
        .await;
        match finish {
            Ok(()) => {
                host.approved.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            Err(error) => {
                host.closing.store(false, Ordering::SeqCst);
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("desktop:close-cancelled", ());
                }
                app.dialog().message(error).title("尚未退出").show(|_| {});
            }
        }
    });
}

#[tauri::command]
async fn smoke_complete(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    result: Value,
    host: tauri::State<'_, Host>,
) -> Result<(), String> {
    local_window(&window)?;
    if !host.smoke
        || result["configured"] != false
        || result["phase"] != "stopped"
        || result["feishuConnected"] != false
        || result["renderer"] != true
        || result["assetsLoaded"] != true
        || result["errorsVisible"] != true
        || result["ipc"] != true
    {
        return Err("smoke_profile_not_isolated".into());
    }
    host.bridge.close().await?;
    println!(
        "CONNECTOR_NATIVE_SMOKE {}",
        json!({"version":env!("CARGO_PKG_VERSION"),"renderer":true,"assetsLoaded":true,"errorsVisible":true,"ipc":true,"configured":false,"phase":"stopped","feishuConnected":false})
    );
    std::fs::remove_dir_all(&host.root).map_err(|_| "无法清理测试档案")?;
    host.approved.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}

fn initialize(app: &mut tauri::App, smoke: bool) -> Result<(), Box<dyn std::error::Error>> {
    let root = storage::data_root(smoke, cfg!(debug_assertions))?;
    let key = storage::storage_key(&root, smoke)?;
    let runtime = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../.artifacts/native-runtime")
    } else {
        app.path().resource_dir().map_err(|_| "无法定位 App 资源。请将完整 App 放入“应用程序”，不要通过符号链接或单独移动可执行文件启动。")?.join("runtime")
    };
    if !runtime.join("backend/desktop/native-entry.js").is_file() {
        return Err("运行环境缺失，请执行 pnpm native:prepare 或安装完整 App".into());
    }
    let handle = app.handle().clone();
    let bridge = tauri::async_runtime::block_on(Bridge::spawn(
        &runtime,
        Arc::new(move |event, value| {
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.emit(event, value);
            }
        }),
    ))?;
    let initialized = tauri::async_runtime::block_on(bridge.request(
        "initialize",
        json!({"root":root,"key":hex::encode(&*key),"diagnostic":smoke}),
    ));
    if let Err(error) = initialized {
        tauri::async_runtime::block_on(bridge.close()).ok();
        return Err(error.into());
    }
    app.manage(Host {
        bridge,
        root,
        closing: AtomicBool::new(false),
        approved: AtomicBool::new(false),
        flush: Mutex::new(None),
        smoke,
    });
    let mut config = app.config().app.windows[0].clone();
    config.visible = !smoke;
    let window = tauri::WebviewWindowBuilder::from_config(app, &config)?
        .on_navigation(console_url)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_permission_request(|_, _| tauri::webview::PermissionResponse::Deny)
        .build()?;
    if smoke {
        let mut url = window.url()?;
        url.set_query(Some("smoke=1"));
        window.navigate(url)?;
    }
    Ok(())
}

fn main() {
    let smoke = std::env::args().any(|value| value == "--connector-smoke-test");
    let mut builder = tauri::Builder::default();
    // Diagnostic runs use an ephemeral profile and cannot start services. They
    // must not redirect to or focus an already installed production instance.
    if !smoke {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }
    let result = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            desktop_request,
            draft_flushed,
            smoke_complete
        ])
        .setup(move |app| {
            if let Err(error) = initialize(app, smoke) {
                eprintln!("CodexConnector Rust 启动失败：{error}");
                if let Some(host) = app.try_state::<Host>() {
                    let _ = tauri::async_runtime::block_on(host.bridge.close());
                    host.approved.store(true, Ordering::SeqCst);
                }
                if !smoke {
                    rfd::MessageDialog::new()
                        .set_title("CodexConnector 启动失败")
                        .set_description(error.to_string())
                        .set_level(rfd::MessageLevel::Error)
                        .show();
                }
                app.handle().exit(1);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if let Some(host) = window.try_state::<Host>() {
                    if !host.approved.load(Ordering::SeqCst) {
                        api.prevent_close();
                        begin_quit(window.app_handle().clone());
                    }
                }
            }
        })
        .build(tauri::generate_context!());
    match result {
        Ok(app) => app.run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if let Some(host) = app.try_state::<Host>() {
                    if !host.approved.load(Ordering::SeqCst) {
                        api.prevent_exit();
                        begin_quit(app.clone());
                    }
                }
            }
        }),
        Err(error) => {
            eprintln!("CodexConnector Rust 启动失败：{error}");
            if !smoke {
                rfd::MessageDialog::new()
                    .set_title("CodexConnector 启动失败")
                    .set_description(error.to_string())
                    .set_level(rfd::MessageLevel::Error)
                    .show();
            }
            std::process::exit(1);
        }
    }
}
