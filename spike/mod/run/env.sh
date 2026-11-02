# Sourced by setup.sh inside tmux. In a cloud container the parent Claude
# Code's identity is in the environment (remote entrypoint, inbox socket,
# session id); strip it so the child is a plain local interactive session.
for v in $(env | cut -d= -f1 | grep -E '^(CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$|CLAUDE_AUTO_|CLAUDE_AFTER_|CLAUDE_EFFORT$|CLAUDE_ADDITIONAL_|CCR_|CLAUDE_ENABLE_|CLAUDE_AUTOCOMPACT_|SESSION_INGRESS_URL$|AI_AGENT$|DOCUMENTS_MCP_)'); do
  unset "$v"
done
export TERM=xterm-256color
