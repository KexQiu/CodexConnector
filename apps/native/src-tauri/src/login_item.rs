use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
use objc2_foundation::NSError;
use serde_json::{json, Value};

#[link(name = "ServiceManagement", kind = "framework")]
extern "C" {}

fn service() -> Retained<AnyObject> {
    unsafe { msg_send![class!(SMAppService), mainAppService] }
}
pub fn read(development: bool) -> Value {
    if development {
        return json!({"supported":false,"canEnable":false,"status":"unavailable","enabled":false,"requested":false,
            "message":"开发模式不注册登录项。请安装 Rust App 后在应用内开启。"});
    }
    let installed = std::env::current_exe()
        .ok()
        .is_some_and(|p| p.starts_with("/Applications"));
    let status: isize = unsafe { msg_send![&*service(), status] };
    let (label, message) = match status {
        0 => ("not-registered", "未开启，登录 Mac 时不会自动打开 App。"),
        1 => ("enabled", "已开启，下次登录 Mac 时自动打开 App。"),
        2 => (
            "requires-approval",
            "等待系统批准，请在系统设置的“登录项”中允许此 App。",
        ),
        _ => (
            "not-found",
            "系统未找到此应用的登录项，请确认已安装到“应用程序”。",
        ),
    };
    json!({"supported":true,"canEnable":installed,"status":label,"enabled":status==1,"requested":status==1||status==2,
        "message":if installed {message} else {"请先将 Rust App 移到“应用程序”文件夹，再开启自启。"}})
}
pub fn set(enabled: bool, development: bool) -> Result<Value, String> {
    let before = read(development);
    if before["supported"] != true || (enabled && before["canEnable"] != true) {
        return Err(before["message"]
            .as_str()
            .unwrap_or("无法修改登录项")
            .into());
    }
    if before["requested"] == enabled {
        return Ok(before);
    }
    let mut error: Option<Retained<NSError>> = None;
    let success: bool = unsafe {
        if enabled {
            msg_send![&*service(), registerAndReturnError: &mut error]
        } else {
            msg_send![&*service(), unregisterAndReturnError: &mut error]
        }
    };
    if !success {
        return Err("未能修改 macOS 登录项，请检查系统权限后重试".into());
    }
    let after = read(development);
    if after["requested"] != enabled {
        return Err("系统尚未确认登录项变更，请刷新状态".into());
    }
    Ok(after)
}
