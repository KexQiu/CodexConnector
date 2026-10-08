use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Queued,
    Starting,
    Running,
    Completed,
    Failed,
    Interrupted,
    Unknown,
}

impl TaskStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Interrupted)
    }

    pub fn holds_execution_lock(self) -> bool {
        matches!(self, Self::Starting | Self::Running | Self::Unknown)
    }

    /// A structural guard only; RPC evidence is still required before transition.
    pub fn can_transition(self, next: Self) -> bool {
        self == next
            || match self {
                Self::Queued => matches!(next, Self::Starting | Self::Failed | Self::Interrupted),
                Self::Starting => matches!(
                    next,
                    Self::Running
                        | Self::Completed
                        | Self::Failed
                        | Self::Interrupted
                        | Self::Unknown
                ),
                Self::Running => matches!(
                    next,
                    Self::Completed | Self::Failed | Self::Interrupted | Self::Unknown
                ),
                Self::Unknown => matches!(
                    next,
                    Self::Running | Self::Completed | Self::Failed | Self::Interrupted
                ),
                Self::Completed | Self::Failed | Self::Interrupted => false,
            }
    }
}
