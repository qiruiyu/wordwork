# Security boundaries

- Deploy behind HTTPS. Session tokens are stored in the database and can be revoked individually,
  so there is no separate signing secret to manage.
- Change the bootstrap password before adding real documents.
- The API authorizes every project-scoped read and write; knowing a version ID is insufficient.
- Only `.docx` ZIP packages are accepted. Macro parts, encrypted packages, unsafe paths and extreme
  compression ratios are rejected before storage or parsing.
- External OOXML relationships are reported but never fetched.
- HTML previews contain escaped text and a fixed local stylesheet; raw document HTML is not served.
- Original upload names are not used as filesystem paths.
- Audit logs exclude document text and authentication secrets.
- The data directory is not encrypted at rest. Backups are plain copies, so protect the backup
  destination as carefully as the server itself and keep a copy on a second private host.
- A domain-less deployment terminates TLS with a private CA. Every client machine must trust that
  CA's root certificate, and trusting it means trusting anything that CA signs — import it only
  from a copy handed over out of band, and check the fingerprint matches the server's.

For the pilot, the administrator must run one restore exercise before formal grant material is used.

