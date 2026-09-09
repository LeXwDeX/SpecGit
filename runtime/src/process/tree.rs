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
#[cfg(unix)]
impl Drop for Tree {
    fn drop(&mut self) {
        // SAFETY: this is the process group created for this owned child only.
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
