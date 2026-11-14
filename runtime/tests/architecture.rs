//! Verify runtime component dependencies from every production Rust source file.
//! Parse every platform's code. Unit-test modules and internal component edges
//! are outside this contract; integration and installed tests verify behavior.
use proc_macro2::{Literal, TokenStream, TokenTree};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};
use syn::{Item, UseTree, visit::Visit};

type Graph = BTreeMap<String, BTreeSet<String>>;

fn layer(module: &str) -> u8 {
    match module {
        "diagnostic" | "input" | "identity" | "label_rules" | "declaration" | "template_rules"
        | "spec" | "delivery_model" | "observation_model" | "forge_routes" | "prompts"
        | "report" | "i18n" | "project_receipt" => 0,
        "assets" | "process" | "cli_contract" => 1,
        "project" | "config" | "templates" | "selection" | "watch_store" | "migration_assets"
        | "local_exclude" | "guidance" | "self_update" | "skill" => 2,
        "forge_read" => 3,
        "probe" | "native_checks" | "native_file" => 4,
        "forge" => 5,
        "native_delivery" | "migration_remote" => 6,
        "delivery_context" => 7,
        "init" | "issue" | "pr" | "observation" | "migrate" | "watch" | "guard" | "setup" => 8,
        "hook" | "remove" => 9,
        "cli" => 10,
        other => {
            panic!("Assign new runtime component {other} a layer and update docs/architecture.md")
        }
    }
}

#[derive(Default)]
struct Dependencies {
    components: BTreeSet<String>,
    paths: BTreeSet<String>,
    module_path: Vec<String>,
}
impl Dependencies {
    fn path(&mut self, segments: impl IntoIterator<Item = String>) {
        let segments: Vec<_> = segments.into_iter().collect();
        if segments.len() >= 2 && matches!(segments[0].as_str(), "crate" | "specgit") {
            self.components.insert(segments[1].clone());
        } else if segments
            .first()
            .is_some_and(|root| matches!(root.as_str(), "self" | "super"))
        {
            let mut resolved = self.module_path.clone();
            let mut index = 0;
            if segments[0] == "self" {
                index = 1;
            } else {
                while segments
                    .get(index)
                    .is_some_and(|segment| segment == "super")
                {
                    resolved.pop();
                    index += 1;
                }
            }
            resolved.extend_from_slice(&segments[index..]);
            if let Some(component) = resolved.first() {
                self.components.insert(component.clone());
            }
        }
        self.paths.insert(segments.join("::"));
    }
    fn import(&mut self, tree: &UseTree, prefix: &mut Vec<String>) {
        match tree {
            UseTree::Path(path) => {
                prefix.push(path.ident.to_string());
                self.import(&path.tree, prefix);
                prefix.pop();
            }
            UseTree::Group(group) => {
                for item in &group.items {
                    self.import(item, prefix);
                }
            }
            UseTree::Name(name) => {
                self.path(prefix.iter().cloned().chain([name.ident.to_string()]));
            }
            UseTree::Rename(name) => {
                self.path(prefix.iter().cloned().chain([name.ident.to_string()]));
            }
            UseTree::Glob(_) => self.path(prefix.clone()),
        }
    }
    // syn treats macro arguments as opaque tokens. Scan token trees as well so
    // expressions inside json!, format!, etc. cannot hide component dependencies.
    // String literals and comments are never identifiers in this representation.
    fn tokens(&mut self, stream: TokenStream) {
        let tokens: Vec<_> = stream.into_iter().collect();
        for (index, token) in tokens.iter().enumerate() {
            if let TokenTree::Group(group) = token {
                self.tokens(group.stream());
            }
            let TokenTree::Ident(root) = token else {
                continue;
            };
            if !matches!(
                root.to_string().as_str(),
                "crate" | "specgit" | "std" | "tokio" | "self" | "super"
            ) {
                continue;
            }
            let mut segments = vec![root.to_string()];
            let mut cursor = index + 1;
            while matches!(tokens.get(cursor), Some(TokenTree::Punct(p)) if p.as_char() == ':')
                && matches!(tokens.get(cursor + 1), Some(TokenTree::Punct(p)) if p.as_char() == ':')
            {
                let Some(TokenTree::Ident(segment)) = tokens.get(cursor + 2) else {
                    break;
                };
                segments.push(segment.to_string());
                cursor += 3;
            }
            if segments.len() > 1 {
                self.path(segments);
            }
        }
    }
}
impl<'ast> Visit<'ast> for Dependencies {
    fn visit_item_mod(&mut self, module: &'ast syn::ItemMod) {
        if !unit_test_module(module) {
            self.module_path.push(module.ident.to_string());
            syn::visit::visit_item_mod(self, module);
            self.module_path.pop();
        }
    }
    fn visit_path(&mut self, path: &'ast syn::Path) {
        self.path(
            path.segments
                .iter()
                .map(|segment| segment.ident.to_string()),
        );
        syn::visit::visit_path(self, path);
    }
    fn visit_item_use(&mut self, item: &'ast syn::ItemUse) {
        self.import(&item.tree, &mut Vec::new());
    }
    fn visit_macro(&mut self, node: &'ast syn::Macro) {
        self.tokens(node.tokens.clone());
        syn::visit::visit_macro(self, node);
    }
}

fn source_files(directory: &Path, files: &mut Vec<std::path::PathBuf>) {
    for entry in fs::read_dir(directory).expect("runtime source inventory") {
        let path = entry.unwrap().path();
        if path.is_dir() {
            source_files(&path, files);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            files.push(path);
        }
    }
}

fn component(path: &Path) -> String {
    let first = path
        .components()
        .next()
        .unwrap()
        .as_os_str()
        .to_str()
        .unwrap();
    first.strip_suffix(".rs").unwrap_or(first).to_owned()
}

fn unit_test_module(module: &syn::ItemMod) -> bool {
    module.attrs.iter().any(|attr| {
        attr.path().is_ident("cfg")
            && matches!(&attr.meta, syn::Meta::List(meta) if meta.tokens.to_string() == "test")
    })
}

// docs/architecture.md "Host-neutral product principle" says host-specific
// code lives only in setup adapters. These are this checkout's host access
// surface modules; a new host integration must be declared here.
const HOST_ACCESS_SURFACE: [&str; 9] = [
    "setup",
    "project_receipt",
    "migration_assets",
    "guidance",
    "local_exclude",
    "remove",
    "migrate",
    "init",
    "cli",
];
// Case-insensitive substrings also cover `.claude/`, `CLAUDE.md`, `.codex/`,
// `.opencode/`, and `.graphagent/`; the override file has its own name.
const HOST_NAMES: [&str; 4] = ["claude", "codex", "opencode", "graphagent"];
const HOST_OVERRIDE: &str = "agents.override.md";
const HOOK_EVENTS: [&str; 4] = ["SessionStart", "PreToolUse", "PostToolUse", "Stop"];
const HOST_TOOL_NAMES: [&str; 13] = [
    "Bash",
    "Read",
    "Write",
    "Edit",
    "MultiEdit",
    "Grep",
    "Glob",
    "Task",
    "TodoWrite",
    "WebFetch",
    "NotebookEdit",
    "SlashCommand",
    "AskUserQuestion",
];

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum HostIdentifier {
    Name,
    Event,
    Tool,
}

impl HostIdentifier {
    fn allows(self, component: &str) -> bool {
        match self {
            // Distributed Skills and guidance never name a host tool.
            Self::Tool => false,
            Self::Name => HOST_ACCESS_SURFACE.contains(&component),
            // The hook entry point is itself a host adaptation.
            Self::Event => HOST_ACCESS_SURFACE.contains(&component) || component == "hook",
        }
    }

    fn boundary(self) -> &'static str {
        match self {
            Self::Name => "host names and paths belong to the host access surface",
            Self::Event => "host hook events belong to the host access surface and hook",
            Self::Tool => "host tool names are forbidden in runtime source and distributed text",
        }
    }
}

#[derive(Default)]
struct HostVocabulary {
    found: BTreeSet<(HostIdentifier, String)>,
}
impl HostVocabulary {
    fn text(&mut self, text: &str) {
        let lowercase = text.to_lowercase();
        if HOST_NAMES.iter().any(|name| lowercase.contains(name))
            || lowercase.contains(HOST_OVERRIDE)
        {
            self.found.insert((HostIdentifier::Name, text.to_owned()));
        }
        // Event names are exact literals: "Stop" is also an English word, so a
        // substring match would report ordinary prose.
        if HOOK_EVENTS.contains(&text) {
            self.found.insert((HostIdentifier::Event, text.to_owned()));
        }
        // Tool names in code are exact literals too; business prose such as
        // "Read the current selection" is not a host tool reference.
        if HOST_TOOL_NAMES.contains(&text) {
            self.found.insert((HostIdentifier::Tool, text.to_owned()));
        }
    }
    fn literal(&mut self, literal: &Literal) {
        if let syn::Lit::Str(text) = syn::Lit::new(literal.clone()) {
            self.text(&text.value());
        }
    }
    // syn leaves macro arguments opaque. Scan their token trees as well so
    // json!, format!, and matches! cannot hide host identifiers.
    fn tokens(&mut self, stream: TokenStream) {
        for token in stream {
            match token {
                TokenTree::Group(group) => self.tokens(group.stream()),
                TokenTree::Literal(literal) => self.literal(&literal),
                _ => {}
            }
        }
    }
}
impl<'ast> Visit<'ast> for HostVocabulary {
    fn visit_item_mod(&mut self, module: &'ast syn::ItemMod) {
        if !unit_test_module(module) {
            syn::visit::visit_item_mod(self, module);
        }
    }
    fn visit_attribute(&mut self, attribute: &'ast syn::Attribute) {
        // `///` comments arrive as `#[doc = "..."]`; prose is not code.
        if !attribute.path().is_ident("doc") {
            syn::visit::visit_attribute(self, attribute);
        }
    }
    fn visit_lit_str(&mut self, literal: &'ast syn::LitStr) {
        self.text(&literal.value());
        syn::visit::visit_lit_str(self, literal);
    }
    fn visit_macro(&mut self, node: &'ast syn::Macro) {
        self.tokens(node.tokens.clone());
        syn::visit::visit_macro(self, node);
    }
}

fn host_references(syntax: &syn::File) -> BTreeSet<(HostIdentifier, String)> {
    let mut vocabulary = HostVocabulary::default();
    vocabulary.visit_file(syntax);
    vocabulary.found
}

fn host_violations(component: &str, relative: &Path, syntax: &syn::File) -> Vec<String> {
    host_references(syntax)
        .into_iter()
        .filter(|(identifier, _)| !identifier.allows(component))
        .map(|(identifier, literal)| {
            format!(
                "{}: {component} contains {:?}; {}",
                relative.display(),
                literal,
                identifier.boundary()
            )
        })
        .collect()
}

// Tool names that are also ordinary English words count as host tool
// references only when marked up as code or quoted. "Read project-root" is
// product prose; `Read` and `"Bash"` name host tools.
const PROSE_TOOL_NAMES: [&str; 7] = ["Bash", "Read", "Write", "Edit", "Grep", "Glob", "Task"];

fn word_occurrences(text: &str, word: &str) -> Vec<usize> {
    let boundary = |character: Option<char>| {
        character.is_none_or(|character| !character.is_alphanumeric() && character != '_')
    };
    let mut indices = Vec::new();
    let mut offset = 0;
    while let Some(index) = text[offset..].find(word) {
        let start = offset + index;
        let end = start + word.len();
        if boundary(text[..start].chars().next_back()) && boundary(text[end..].chars().next()) {
            indices.push(start);
        }
        offset = end;
    }
    indices
}

fn marked_up(text: &str, start: usize, end: usize) -> bool {
    let quote = |character: Option<char>| matches!(character, Some('`' | '"'));
    quote(text[..start].chars().next_back()) && quote(text[end..].chars().next())
}

fn tool_name_mentions(text: &str) -> Vec<&'static str> {
    HOST_TOOL_NAMES
        .iter()
        .copied()
        .filter(|name| {
            let occurrences = word_occurrences(text, name);
            if PROSE_TOOL_NAMES.contains(name) {
                occurrences
                    .iter()
                    .any(|start| marked_up(text, *start, start + name.len()))
            } else {
                !occurrences.is_empty()
            }
        })
        .collect()
}

fn cycle(graph: &Graph) -> Option<Vec<String>> {
    fn visit(
        graph: &Graph,
        module: &str,
        done: &mut BTreeSet<String>,
        active: &mut Vec<String>,
    ) -> Option<Vec<String>> {
        if let Some(index) = active.iter().position(|name| name == module) {
            let mut cycle = active[index..].to_vec();
            cycle.push(module.into());
            return Some(cycle);
        }
        if done.contains(module) {
            return None;
        }
        active.push(module.into());
        for dependency in &graph[module] {
            if let Some(cycle) = visit(graph, dependency, done, active) {
                return Some(cycle);
            }
        }
        active.pop();
        done.insert(module.into());
        None
    }
    let mut done = BTreeSet::new();
    for module in graph.keys() {
        if let Some(cycle) = visit(graph, module, &mut done, &mut vec![]) {
            return Some(cycle);
        }
    }
    None
}

fn verify_documentation(documentation: &str, graph: &Graph) -> Result<(), String> {
    let table = documentation
        .split_once("<!-- runtime-components:start -->")
        .and_then(|(_, rest)| rest.split_once("<!-- runtime-components:end -->"))
        .map(|(table, _)| table)
        .ok_or("Missing runtime component table")?;
    let mut documented = Graph::new();
    for line in table.lines().filter(|line| line.starts_with("| `")) {
        let fields: Vec<_> = line.split('|').map(str::trim).collect();
        if fields.len() != 5 {
            return Err(format!("Malformed component row: {line}"));
        }
        let module = fields[1].trim_matches('`');
        if !graph.contains_key(module) {
            return Err(format!("Unknown documented component {module}"));
        }
        if fields[2].parse::<u8>().ok() != Some(layer(module)) {
            return Err(format!("Wrong documented layer for {module}"));
        }
        let dependencies = if fields[3] == "—" {
            BTreeSet::new()
        } else {
            fields[3]
                .split(',')
                .map(|name| name.trim().trim_matches('`').to_owned())
                .collect()
        };
        if documented.insert(module.to_owned(), dependencies).is_some() {
            return Err(format!("Duplicate documented component {module}"));
        }
    }
    if &documented != graph {
        return Err("Runtime component table differs from source dependencies".into());
    }
    let diagram = documentation
        .split_once("```mermaid")
        .and_then(|(_, rest)| rest.split_once("```"))
        .map(|(diagram, _)| diagram)
        .ok_or("Missing module dependency diagram")?;
    for line in diagram.lines() {
        if let Some((owner, dependency)) = line.trim().split_once(" --> ")
            && !graph
                .get(owner)
                .is_some_and(|edges| edges.contains(dependency))
        {
            return Err(format!(
                "Diagram edge is absent from source: {owner} -> {dependency}"
            ));
        }
    }
    Ok(())
}

#[test]
fn all_runtime_components_follow_an_acyclic_layered_dependency_graph() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = vec![];
    source_files(&root, &mut files);
    files.sort();
    let mut graph = Graph::new();
    let mut origins = BTreeMap::new();
    for path in &files {
        let relative = path.strip_prefix(&root).unwrap();
        // lib.rs declares the library; main.rs only declares the CLI entry point.
        if matches!(relative.to_str(), Some("lib.rs" | "main.rs")) {
            continue;
        }
        let owner = component(relative);
        let source = fs::read_to_string(path).unwrap();
        let syntax = syn::parse_file(&source).unwrap_or_else(|error| {
            panic!(
                "Parse every platform's runtime source {}: {error}",
                path.display()
            )
        });
        let mut dependencies = Dependencies {
            module_path: relative
                .iter()
                .map(|part| {
                    Path::new(part)
                        .file_stem()
                        .unwrap()
                        .to_string_lossy()
                        .into_owned()
                })
                .collect(),
            ..Dependencies::default()
        };
        if dependencies
            .module_path
            .last()
            .is_some_and(|name| name == "mod")
        {
            dependencies.module_path.pop();
        }
        dependencies.visit_file(&syntax);
        let owner_layer = layer(&owner);
        if owner_layer == 0 {
            for path in &dependencies.paths {
                assert!(
                    ![
                        "std::fs",
                        "std::process",
                        "std::net",
                        "std::env",
                        "std::thread",
                        "tokio::",
                        "crate::process"
                    ]
                    .iter()
                    .any(|prefix| path.starts_with(prefix)),
                    "Pure component {owner} depends on IO path {path} in {}",
                    relative.display()
                );
            }
        }
        let edges = graph.entry(owner.clone()).or_default();
        for dependency in dependencies.components {
            if dependency != owner {
                origins.insert((owner.clone(), dependency.clone()), relative.to_owned());
                edges.insert(dependency);
            }
        }
    }
    let declared = syn::parse_file(&fs::read_to_string(root.join("lib.rs")).unwrap()).unwrap();
    for item in declared.items {
        if let Item::Mod(module) = item {
            assert!(
                graph.contains_key(&module.ident.to_string()),
                "Missing declared component {}",
                module.ident
            );
        }
    }
    for dependency in ["assets", "guidance", "guard"] {
        assert!(
            graph["cli"].contains(dependency),
            "The CLI doctor maintenance path must use typed {dependency} plans"
        );
    }
    for (owner, dependency) in [
        ("init", "setup"),
        ("setup", "guidance"),
        ("setup", "local_exclude"),
        ("setup", "guard"),
        ("setup", "project_receipt"),
        ("config", "project_receipt"),
        ("init", "guard"),
    ] {
        assert!(
            graph[owner].contains(dependency),
            "Stable project guidance uses the shared typed plan: {owner} -> {dependency}"
        );
    }
    for (owner, dependencies) in &graph {
        for dependency in dependencies {
            assert!(
                graph.contains_key(dependency),
                "Unknown component {owner} -> {dependency}"
            );
            assert!(
                layer(owner) >= layer(dependency),
                "Upward dependency {owner} -> {dependency} in {}",
                origins[&(owner.clone(), dependency.clone())].display()
            );
        }
    }
    if let Some(cycle) = cycle(&graph) {
        panic!("Runtime component cycle: {}", cycle.join(" -> "));
    }
    let documentation = fs::read_to_string(root.join("../../docs/architecture.md")).unwrap();
    verify_documentation(&documentation, &graph).unwrap_or_else(|error| panic!("{error}"));
    println!(
        "Verified {} runtime components in {} source files: no cycles or layer violations",
        graph.len(),
        files.len()
    );
}

#[test]
fn dependency_scanner_covers_grouped_aliases_macros_and_platform_code() {
    let source = syn::parse_file(
        r#"
        use crate::{process::Process, report as presentation, identity::*};
        #[cfg(windows)] fn platform() { crate::assets::hash(b"x"); }
        fn nested() { json!({"value": crate::declaration::MAX_BYTES}); }
        mod inner { use super::super::templates; }
        const TEXT: &str = "crate::fake::value";
        #[cfg(test)] mod tests { use crate::test_only; }
    "#,
    )
    .unwrap();
    let mut dependencies = Dependencies {
        module_path: vec!["fixture".into()],
        ..Dependencies::default()
    };
    dependencies.visit_file(&source);
    assert_eq!(
        dependencies.components,
        BTreeSet::from([
            "assets".into(),
            "declaration".into(),
            "identity".into(),
            "process".into(),
            "report".into(),
            "templates".into(),
        ])
    );
    let graph = BTreeMap::from([
        ("a".into(), BTreeSet::from(["b".into()])),
        ("b".into(), BTreeSet::from(["a".into()])),
    ]);
    assert_eq!(
        cycle(&graph),
        Some(vec!["a".into(), "b".into(), "a".into()])
    );
}

#[test]
fn host_specific_identifiers_stay_inside_the_host_access_surface() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = vec![];
    source_files(&root, &mut files);
    files.sort();
    let mut violations = Vec::new();
    for path in &files {
        let relative = path.strip_prefix(&root).unwrap();
        let owner = component(relative);
        let source = fs::read_to_string(path).unwrap();
        let syntax = syn::parse_file(&source).unwrap_or_else(|error| {
            panic!(
                "Parse every platform's runtime source {}: {error}",
                path.display()
            )
        });
        violations.extend(host_violations(&owner, relative, &syntax));
    }
    assert!(
        violations.is_empty(),
        "Host-specific identifiers escaped the host access surface ({}). Hook event names additionally belong to hook; host tool names are forbidden in runtime source and distributed text. docs/architecture.md \"Host-neutral product principle\": add new host adaptations to a host access surface module and declare it here.\n{}",
        HOST_ACCESS_SURFACE.join(", "),
        violations.join("\n")
    );
    println!("Verified host-neutral source in {} files", files.len());
}

#[test]
fn distributed_skills_and_generated_guidance_name_no_host_tools() {
    let guidance = specgit::guidance::render(&specgit::declaration::Declaration::default());
    // prompts::project returns the embedded host entry for every language, so
    // this asset check covers both En and Zh generated guidance.
    let sources = [
        ("assets/SKILL.md", include_str!("../assets/SKILL.md")),
        (
            "assets/prompts/host-entry.md",
            include_str!("../assets/prompts/host-entry.md"),
        ),
        ("guidance::render", guidance.as_str()),
    ];
    let mut violations = Vec::new();
    for (name, text) in sources {
        for tool in tool_name_mentions(text) {
            violations.push(format!("{name} names host tool {tool}"));
        }
    }
    assert!(
        violations.is_empty(),
        "Distributed Skills and guidance text contain no host-specific tool names (docs/architecture.md \"Host-neutral product principle\").\n{}",
        violations.join("\n")
    );
}

#[test]
fn host_vocabulary_scanner_reports_violations_and_exempts_adapters_tests_and_docs() {
    let fixture = syn::parse_file(
        r#"
        /// `AGENTS.override.md` in documentation is prose, not code.
        fn business() {
            let host = ".codex/agents";
            let event = "PreToolUse";
            let stop = "Stop";
            let prose = "Stop before the second write.";
            let tool = "Bash";
            json!({"path": ".claude/settings.json", "tool": "AskUserQuestion"});
        }
        #[cfg(test)] mod tests { const FIXTURE: &str = ".graphagent/fixture"; }
        "#,
    )
    .unwrap();
    assert_eq!(
        host_references(&fixture),
        BTreeSet::from([
            (HostIdentifier::Name, ".claude/settings.json".into()),
            (HostIdentifier::Name, ".codex/agents".into()),
            (HostIdentifier::Event, "PreToolUse".into()),
            (HostIdentifier::Event, "Stop".into()),
            (HostIdentifier::Tool, "AskUserQuestion".into()),
            (HostIdentifier::Tool, "Bash".into()),
        ])
    );
    let relative = Path::new("fixture.rs");
    assert_eq!(host_violations("assets", relative, &fixture).len(), 6);
    assert_eq!(host_violations("spec", relative, &fixture).len(), 6);
    assert_eq!(host_violations("setup", relative, &fixture).len(), 2);
    // hook adapts hook events, not host names or tools.
    assert_eq!(host_violations("hook", relative, &fixture).len(), 4);
    assert_eq!(host_violations("guidance", relative, &fixture).len(), 2);
}

#[test]
fn guidance_tool_scanner_ignores_prose_and_reports_marked_up_tool_names() {
    assert!(
        tool_name_mentions("Read project-root `.agents/skills/specgit-native/SKILL.md`.")
            .is_empty()
    );
    assert_eq!(
        tool_name_mentions("Use `Read` or \"Bash\"."),
        vec!["Bash", "Read"]
    );
    assert_eq!(tool_name_mentions("TodoWrite"), vec!["TodoWrite"]);
    assert!(tool_name_mentions("Read/Write access and a Grep-like filter").is_empty());
}

#[test]
fn architecture_documentation_rejects_missing_modules_false_edges_and_layers() {
    let graph = BTreeMap::from([
        ("spec".into(), BTreeSet::from(["identity".into()])),
        ("identity".into(), BTreeSet::new()),
    ]);
    let document = "<!-- runtime-components:start -->\n| `spec` | 0 | `identity` |\n| `identity` | 0 | — |\n<!-- runtime-components:end -->\n```mermaid\nflowchart TD\nspec --> identity\n```";
    assert!(verify_documentation(document, &graph).is_ok());
    assert!(
        verify_documentation(&document.replace("| `identity` | 0 | — |\n", ""), &graph).is_err()
    );
    assert!(
        verify_documentation(
            &document.replace("spec --> identity", "identity --> spec"),
            &graph
        )
        .is_err()
    );
    assert!(
        verify_documentation(&document.replace("| `spec` | 0", "| `spec` | 1"), &graph).is_err()
    );
    assert!(
        cycle(&graph).is_none(),
        "same-layer dependencies can be acyclic"
    );
}
