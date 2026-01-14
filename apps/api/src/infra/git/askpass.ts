export function gitAskpassScriptV1() {
  // NOTE: keep POSIX sh compatible
  return `#!/bin/sh
prompt="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
case "$prompt" in
  *username*) printf '%s' "$GIT_ASKPASS_USERNAME" ;;
  *)
    if [ -n "$GIT_ASKPASS_TOKEN_FILE" ] && [ -r "$GIT_ASKPASS_TOKEN_FILE" ]; then
      # read first line (POSIX), avoid putting secrets into argv
      # NOTE: if the file does not end with a trailing newline, read may return non-zero on EOF
      # but still set $token; do NOT overwrite it via || token="".
      IFS= read -r token < "$GIT_ASKPASS_TOKEN_FILE"
      # strip a trailing CR (e.g. token file saved as CRLF) without calling external commands
      cr=$(printf '\r')
      token=\${token%$cr}
      printf '%s' "$token"
    else
      printf '%s' "$GIT_ASKPASS_TOKEN"
    fi
    ;;
esac
`;
}
