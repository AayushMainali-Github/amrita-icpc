# AMRITA ICPC Codeforces scoreboard

Small static scoreboard for the users in `usernames.json` and the target problems in `problems.json`.

The page calls the public Codeforces `user.status` API, finds accepted submissions for each target problem, and ranks users by:

1. target problems solved, descending;
2. equal solved counts share the same rank.

Results are cached in `localStorage` for ten minutes. The Refresh button bypasses that cache.

## Run locally

The JSON files need to be served over HTTP. From this directory, run:

```text
python -m http.server 8080
```

Then open <http://localhost:8080>.

The site is dependency-free and can be hosted by GitHub Pages or any static web server.
