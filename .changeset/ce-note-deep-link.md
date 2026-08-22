---
"specgit": patch
---

Fix `specgit issue` adoption on GitLab CE: CE issue notes carry no
`web_url`, and the adapter rejected exactly that normal payload
(#252). The note deep-link is now derived deterministically from the
returned id; only a payload carrying neither `web_url` nor an id fails
closed. Found and verified against a live 19.3.0 CE instance.
