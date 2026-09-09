# Standing authorizations

Write one owner-granted authorization per line. Keep the owner's words and provenance intact:

```
- <act> — when <condition> — never <exclusion> — given <YYYY-MM-DD, channel/message>
```

Example:

```
- commit completed work — when required gates pass — never publish, force-push, delete a remote branch, or deploy to production — given 2026-09-09, Atrium/signed owner message
```

An Atrium authorization posted and signed by the owner is the authorization; do not request a
second console paste. A line without `given` is not an authorization.
