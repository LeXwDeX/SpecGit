//! External callers keep the 2.6.2 construction and destructuring contract of
//! public delivery facts. New evidence uses additive types instead.
use specgit::delivery_model::{CandidateRead, CandidateSearch, Pagination, ProjectFacts};
use specgit::identity::{Provider, Repository};

#[test]
fn candidate_read_keeps_its_previous_fields() {
    let read = CandidateRead {
        issues: vec![],
        pagination: Pagination {
            pages_fetched: 1,
            items_seen: 0,
            page_limit: 10,
            complete: true,
        },
    };
    let CandidateRead { issues, pagination } = read;
    assert!(issues.is_empty() && pagination.complete);
    let search = CandidateSearch {
        read: CandidateRead { issues, pagination },
        history: vec![],
        history_diagnostics: vec![],
    };
    assert!(search.history.is_empty());
}

#[test]
fn project_facts_keep_their_previous_fields() {
    let facts = ProjectFacts {
        id: 1,
        repository: Repository {
            provider: Provider::Github,
            host: "github.com".into(),
            path: "owner/repo".into(),
        },
        default_branch: "main".into(),
        native_source_cleanup: None,
        native_issue_closing: None,
    };
    let ProjectFacts {
        id,
        repository: _,
        default_branch,
        native_source_cleanup: _,
        native_issue_closing: _,
    } = facts;
    assert_eq!((id, default_branch.as_str()), (1, "main"));
}
