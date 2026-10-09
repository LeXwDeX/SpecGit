//! SpecGit's native runtime. Forge observation has no mutation interface.
pub mod assets;
pub mod config;
pub mod declaration;
pub mod delivery_context;
pub mod diagnostic;
pub mod guard;
pub mod guidance;
pub mod hook;
pub mod i18n;
pub mod identity;
pub mod init;
pub mod input;
pub mod issue;
mod label_rules;
pub mod migrate;
mod migration_assets;
mod migration_remote;
pub mod native_checks;
pub mod native_delivery;
pub mod native_file;
pub mod pr;
pub mod probe;
pub mod process;
pub mod project;
mod prompts;
pub mod remove;
pub mod report;
pub mod selection;
pub mod self_update;
pub mod setup;
pub mod spec;
mod template_rules;
pub mod templates;
pub mod watch;
pub mod watch_store;

pub mod delivery_model;
pub mod forge;
pub mod forge_read;
mod forge_routes;
pub mod observation;
pub mod observation_model;

pub mod cli_contract;

pub mod local_exclude;
