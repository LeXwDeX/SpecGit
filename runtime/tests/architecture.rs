//! Verify runtime component dependencies from every production Rust source file.
//! Parse every platform's code. Unit-test modules and internal component edges
//! are outside this contract; integration and installed tests verify behavior.
use proc_macro2::{TokenStream, TokenTree};
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
        | "report" | "i18n" => 0,
        "assets" | "process" | "cli_contract" => 1,
        "project" | "config" | "templates" | "selection" | "watch_store" | "migration_assets"
        | "local_exclude" | "guidance" | "self_update" => 2,
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
        let unit_test = module.attrs.iter().any(|attr| {
            attr.path().is_ident("cfg")
                && matches!(&attr.meta, syn::Meta::List(meta) if meta.tokens.to_string() == "test")
        });
        if !unit_test {
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
