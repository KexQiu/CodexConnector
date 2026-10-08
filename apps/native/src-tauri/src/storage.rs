use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
};
use zeroize::Zeroizing;

pub fn private_directory(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .map_err(|_| "无法创建私有数据目录")?;
    let metadata = fs::symlink_metadata(path).map_err(|_| "无法读取数据目录")?;
    if !metadata.is_dir()
        || metadata.uid() != unsafe { libc::getuid() }
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err("数据目录必须属于当前用户且权限为 700，不能使用符号链接".into());
    }
    Ok(())
}

pub fn data_root(smoke: bool, development: bool) -> Result<PathBuf, String> {
    let path = if smoke {
        std::env::temp_dir().join(format!("cc-native-smoke-{}", uuid::Uuid::new_v4()))
    } else if development {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../.artifacts/native-user-data")
    } else {
        PathBuf::from(std::env::var_os("HOME").ok_or("无法定位用户目录")?)
            .join("Library/Application Support/CodexConnector Rust")
    };
    private_directory(&path)?;
    fs::canonicalize(path).map_err(|_| "无法定位数据目录".into())
}

pub fn storage_key(root: &Path, smoke: bool) -> Result<Zeroizing<Vec<u8>>, String> {
    use rand::RngCore;
    let generate = || {
        let mut key = Zeroizing::new(vec![0; 32]);
        rand::thread_rng().fill_bytes(&mut key);
        key
    };
    if smoke {
        return Ok(generate());
    }
    let service = "com.codexconnector.native.storage.v1";
    let account = hex::encode(Sha256::digest(root.as_os_str().as_encoded_bytes()));
    match security_framework::passwords::get_generic_password(service, &account) {
        Ok(key) if key.len() == 32 => Ok(Zeroizing::new(key)),
        Ok(_) => Err("Keychain 密钥格式无效，请检查安全存储".into()),
        Err(error) if error.code() == -25300 => {
            // Create only when absent. Locked/denied/unavailable Keychain must never be replaced.
            let key = generate();
            security_framework::passwords::set_generic_password(service, &account, &key)
                .map_err(|_| "无法保存到 Keychain，未保存凭据")?;
            Ok(key)
        }
        Err(_) => Err("无法访问 Keychain，请解锁或授权后重试；不会降级为明文存储".into()),
    }
}

pub fn validate_official_url(value: &str) -> Result<(), String> {
    let url = url::Url::parse(value).map_err(|_| "非法官方入口")?;
    let documentation = url.host_str() == Some("github.com")
        && url.path() == "/larksuite/node-sdk/blob/main/README.zh.md"
        && url.query().is_none();
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || (!documentation
            && !matches!(
                url.host_str(),
                Some("open.feishu.cn" | "accounts.feishu.cn")
            ))
    {
        return Err("只允许打开飞书官方 HTTPS 入口".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn external_urls_cannot_escape_official_hosts() {
        assert!(validate_official_url("https://open.feishu.cn/app/cli_test").is_ok());
        for url in [
            "file:///tmp/a",
            "http://open.feishu.cn",
            "https://open.feishu.cn.evil.test/",
            "https://user@open.feishu.cn/",
            "https://open.feishu.cn:8443/",
        ] {
            assert!(validate_official_url(url).is_err(), "{url}");
        }
    }
    #[test]
    fn private_directory_rejects_links_and_shared_access() {
        let root = std::env::temp_dir().join(format!("cc-storage-test-{}", uuid::Uuid::new_v4()));
        private_directory(&root).unwrap();
        let link = root.join("link");
        std::os::unix::fs::symlink(&root, &link).unwrap();
        assert!(private_directory(&link).is_err());
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(private_directory(&root).is_err());
        fs::remove_file(link).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
