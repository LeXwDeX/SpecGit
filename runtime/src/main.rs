//! Executable entry point; the CLI adapter owns input and framing.
mod cli;

#[tokio::main]
async fn main() {
    cli::run().await;
}
