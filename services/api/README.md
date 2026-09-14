# wordwork API

Run locally with `uvicorn app.main:app --reload` from this directory.  Set
`WORDWORK_DATA_DIR` to choose the SQLite database and content-addressed object store.
On a first run the server seeds `teacher` / `student1` / `student2`, all with password
`wordwork-demo-change-me`. Change or remove these demo accounts before deployment.

The OpenAPI contract is available at `/docs`. DOCX comparisons are deliberately
deferred to `wordwork_doc_engine`; endpoints return 503 until that package is installed.
