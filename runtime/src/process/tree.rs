use tokio::process::{Child, Command};

#[cfg(unix)]
pub fn prepare(command: &mut Command) {
    command.process_group(0);
}
#[cfg(unix)]
pub struct Tree(u32);
#[cfg(unix)]
impl Tree {
    pub fn attach(child: &Child) -> std::io::Result<Self> {
        child
            .id()
            .map(Self)
            .ok_or_else(|| std::io::Error::other("missing child identity"))
    }
}
// Observe completion without releasing the group leader's PID. The caller
// drops Tree (killing remaining group members) before it reaps Child. Descendants
// that deliberately create a new session are outside this process-group boundary.
#[cfg(unix)]
pub async fn observe(child: &mut Child) -> std::io::Result<std::process::ExitStatus> {
    use std::os::unix::process::ExitStatusExt;
    let pid = child
        .id()
        .ok_or_else(|| std::io::Error::other("missing child identity"))?;
    loop {
        // SAFETY: siginfo_t is an output POD; waitid receives a valid pointer and
        // only observes this still-owned child. WNOWAIT leaves it unreaped, so
        // Tree's later group signal cannot address a recycled leader PID.
        let (result, observed, status, code) = unsafe {
            let mut info: libc::siginfo_t = std::mem::zeroed();
            let result = libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            );
            (result, info.si_pid(), info.si_status(), info.si_code)
        };
        if result < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::Interrupted {
                return Err(error);
            }
        } else {
            if observed != 0 {
                let raw = match code {
                    libc::CLD_EXITED => status << 8,
                    libc::CLD_KILLED => status,
                    libc::CLD_DUMPED => status | 0x80,
                    _ => return Err(std::io::Error::other("unexpected child exit event")),
                };
                return Ok(std::process::ExitStatus::from_raw(raw));
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
}
#[cfg(windows)]
pub async fn observe(child: &mut Child) -> std::io::Result<std::process::ExitStatus> {
    child.wait().await
}

#[cfg(unix)]
impl Drop for Tree {
    fn drop(&mut self) {
        // SAFETY: this group was created for our child. The caller has not
        // reaped the leader, and drops this guard before dropping/reaping Child,
        // including on cancellation, so the group identity cannot be recycled.
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGKILL);
        }
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{
        mem::{size_of, zeroed},
        ptr::null,
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First,
                Thread32Next,
            },
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                SetInformationJobObject,
            },
            Threading::{CREATE_SUSPENDED, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
        },
    };
    pub fn prepare(command: &mut Command) {
        command.creation_flags(CREATE_SUSPENDED);
    }
    pub struct Tree(HANDLE);
    // SAFETY: the handle is owned exclusively and used only by kernel handle APIs.
    unsafe impl Send for Tree {}
    impl Drop for Tree {
        fn drop(&mut self) {
            // SAFETY: this guard owns the valid job handle. Closing it kills its children.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    impl Tree {
        pub fn attach(child: &Child) -> std::io::Result<Self> {
            // SAFETY: structures have required sizes, pointers live for each call,
            // handles are closed exactly once. The child is suspended until assigned.
            unsafe {
                let handle = CreateJobObjectW(null(), null());
                if handle.is_null() {
                    return Err(std::io::Error::last_os_error());
                }
                let job = Self(handle);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                let raw = child
                    .raw_handle()
                    .ok_or_else(|| std::io::Error::other("missing child handle"))?;
                if AssignProcessToJobObject(handle, raw as HANDLE) == 0 {
                    return Err(std::io::Error::last_os_error());
                }
                let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
                if snapshot == INVALID_HANDLE_VALUE {
                    return Err(std::io::Error::last_os_error());
                }
                let mut entry: THREADENTRY32 = zeroed();
                entry.dwSize = size_of::<THREADENTRY32>() as u32;
                let mut found = false;
                let mut next = Thread32First(snapshot, &mut entry);
                while next != 0 {
                    if Some(entry.th32OwnerProcessID) == child.id() {
                        let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                        if !thread.is_null() {
                            found = ResumeThread(thread) != u32::MAX;
                            CloseHandle(thread);
                        }
                        break;
                    }
                    next = Thread32Next(snapshot, &mut entry);
                }
                CloseHandle(snapshot);
                if !found {
                    return Err(std::io::Error::other("could not resume owned child"));
                }
                Ok(job)
            }
        }
    }
}
#[cfg(windows)]
pub use windows::{Tree, prepare};
