#!/usr/bin/env bash
# Milyonuse tenancy guard — CLAUDE.md rule 1
#
# Checks the invariant that actually matters: every tenant table is isolated by
# a row-level policy scoped to the current tenant, and that policy applies to
# the table owner too.
#
# Three separate checks, because each one fails differently:
#
#   ENABLE ROW LEVEL SECURITY   without it, no policy runs at all
#   FORCE  ROW LEVEL SECURITY   without it, the table OWNER bypasses every
#                               policy — so a deployment that runs migrations
#                               and serves traffic as the same role has no
#                               isolation, while every test still passes
#   a policy referencing app.current_organization_id()
#                               a table can have organization_id, have RLS on,
#                               and still have no policy — which denies all
#                               access rather than scoping it
#
# Column names are not checked. The policy is the invariant; a policy that
# references a column the table does not have fails when the migration runs.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -d db/migrations ] || [ -z "$(ls -A db/migrations 2>/dev/null | grep -i '\.sql$' || true)" ]; then
  echo "guard:tenancy — no migrations yet"; exit 0
fi

python3 - "$ROOT" <<'PY'
import os, re, sys

root = sys.argv[1]
mig_dir = os.path.join(root, "db", "migrations")
allow_path = os.path.join(root, "scripts", "tenancy-allowlist.txt")

allow = set()
if os.path.exists(allow_path):
    for line in open(allow_path, encoding="utf-8"):
        line = line.split("#", 1)[0].strip()
        if line:
            allow.add(line.lower())

sql = ""
for fn in sorted(os.listdir(mig_dir)):
    if fn.lower().endswith(".sql"):
        sql += open(os.path.join(mig_dir, fn), encoding="utf-8").read() + "\n"

sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.S)
sql = re.sub(r"--[^\n]*", " ", sql)

tables = [
    m.group(1).lower()
    for m in re.finditer(
        r'CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?\s*\(', sql, re.I
    )
]

def last_word(on, off):
    """Tables whose final statement, in migration order, is `on` rather than `off`.

    A migration may lift FORCE inside its own transaction to change data and
    put it straight back (0039). What must hold is how the chain leaves the
    table, so a later NO FORCE with nothing after it fails the guard.
    """
    state = {}
    for m in re.finditer(
        r'ALTER\s+TABLE\s+(?:ONLY\s+)?"?([A-Za-z0-9_]+)"?\s+(?:(' + off + r')|' + on + r')\s+ROW\s+LEVEL\s+SECURITY',
        sql,
        re.I,
    ):
        state[m.group(1).lower()] = m.group(2) is None
    return {table for table, is_on in state.items() if is_on}

enabled = last_word(r"ENABLE", r"DISABLE")
forced = last_word(r"FORCE", r"NO\s+FORCE")

# Policies whose body scopes to the current tenant.
scoped = set()
for m in re.finditer(
    r'CREATE\s+POLICY\s+\S+\s+ON\s+"?([A-Za-z0-9_]+)"?(.*?);', sql, re.I | re.S
):
    if "current_organization_id" in m.group(2).lower():
        scoped.add(m.group(1).lower())

problems = {"row-level security not enabled": [],
            "row-level security not FORCEd (the table owner bypasses it)": [],
            "no policy scoped to app.current_organization_id()": []}

checked = 0
for name in sorted(set(tables)):
    if name in allow:
        continue
    checked += 1
    if name not in enabled:
        problems["row-level security not enabled"].append(name)
    if name not in forced:
        problems["row-level security not FORCEd (the table owner bypasses it)"].append(name)
    if name not in scoped:
        problems["no policy scoped to app.current_organization_id()"].append(name)

if not any(problems.values()):
    print("guard:tenancy — %d table(s) checked, clean" % checked)
    sys.exit(0)

print("")
for label, names in problems.items():
    if names:
        print("  ✗ %s" % label)
        for n in names:
            print("      %s" % n)
print("""
  ─────────────────────────────────────────────────────────────
  Every tenant table needs all three:

      ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
      ALTER TABLE <t> FORCE  ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON <t>
        USING (organization_id = app.current_organization_id());

  If the table is genuinely global, add it to
  scripts/tenancy-allowlist.txt with a reason.
  ─────────────────────────────────────────────────────────────""")
sys.exit(1)
PY
