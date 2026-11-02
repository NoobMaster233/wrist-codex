"""Stop the retired 32178 bridge while leaving the unified relay and Codex running."""
from bridge_process import stop_project_node

print('Retired bridge processes stopped:', stop_project_node('bridge/server.mjs'))
