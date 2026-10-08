use crate::Result;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerIdentity {
    pub tenant_key: String,
    pub app_id: String,
    pub open_id: String,
}

pub fn sha256(text: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(text.as_ref()))
}

pub fn owner_key(owner: &OwnerIdentity) -> Result<String> {
    Ok(sha256(serde_json::to_vec(&[
        &owner.tenant_key,
        &owner.app_id,
        &owner.open_id,
    ])?))
}

pub fn request_key(owner: &str, key: &str) -> Result<String> {
    Ok(sha256(serde_json::to_vec(&[owner, "local", key])?))
}

pub fn legacy_fingerprint(
    project: Option<&str>,
    cwd: &str,
    prompt: &str,
    thread: Option<&str>,
) -> Result<String> {
    Ok(sha256(serde_json::to_vec(&(project, cwd, prompt, thread))?))
}

pub fn conversation_fingerprint(
    conversation: &str,
    project: Option<&str>,
    cwd: &str,
    prompt: &str,
) -> Result<String> {
    Ok(sha256(serde_json::to_vec(&(
        "conversation-v2",
        conversation,
        project,
        cwd,
        prompt,
    ))?))
}
