#!/usr/bin/env bash
# 把本 repo 的 skills 以 symlink 裝進 agent 的個人 skills 目錄。
# 執行時由使用者選擇裝到哪裡:
#   1) ~/.agents/skills   跨 agent 通用約定(Codex、Gemini CLI、Cursor、opencode、Amp、Crush …)
#   2) ~/.claude/skills   Claude Code(它只讀自己的目錄)
# symlink 指向本 clone,不存在第二份拷貝;之後更新只要 `git pull`。
# 冪等:已裝好的跳過;目標位置已有別的東西則警告並跳過,不覆蓋。
#
# 用法:
#   ./install.sh                      互動選單(↑↓ 移動、Enter 確認、q 取消)選擇安裝位置
#   ./install.sh --target <dir> [--target <dir> ...]   不互動,直接裝進指定目錄(可重複)
#   ./install.sh --uninstall [--target <dir> ...]      移除(只刪指向本 repo 的 symlink;
#                                                      未指定 --target 時掃上述兩個預設位置)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$REPO_ROOT/.claude/skills"

if [ ! -d "$SRC" ]; then
  echo "找不到 $SRC,請在 repo 根目錄執行" >&2
  exit 1
fi

MODE="install"
TARGETS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) MODE="uninstall" ;;
    --target)
      [ $# -ge 2 ] || { echo "--target 需要一個目錄參數" >&2; exit 1; }
      TARGETS+=("$2"); shift ;;
    *) echo "未知參數:$1(支援 --uninstall、--target <dir>)" >&2; exit 1 ;;
  esac
  shift
done
if [ ${#TARGETS[@]} -eq 0 ]; then
  if [ "$MODE" = "uninstall" ]; then
    TARGETS=("$HOME/.agents/skills" "$HOME/.claude/skills")
  else
    [ -t 0 ] || { echo "非互動環境無法顯示選單,請改用 --target <dir>" >&2; exit 1; }

    OPTIONS=(
      "~/.agents/skills   跨 agent 通用約定(Codex、Gemini CLI、Cursor、opencode、Amp、Crush …)"
      "~/.claude/skills   Claude Code 專用(它只讀這裡)"
    )
    OPTION_DIRS=("$HOME/.agents/skills" "$HOME/.claude/skills")

    echo "要把 skills 裝到哪裡?(↑↓ 移動、Enter 確認、q 取消)"
    trap 'tput cnorm 2>/dev/null || true' EXIT
    tput civis 2>/dev/null || true
    idx=0
    while true; do
      for i in "${!OPTIONS[@]}"; do
        if [ "$i" -eq "$idx" ]; then
          printf '\033[7m > %s\033[0m\n' "${OPTIONS[$i]}"
        else
          printf '   %s\n' "${OPTIONS[$i]}"
        fi
      done
      IFS= read -rsn1 key
      if [ "$key" = $'\033' ]; then IFS= read -rsn2 -t 1 key || key=""; fi
      case "$key" in
        '[A') idx=$(( (idx + ${#OPTIONS[@]} - 1) % ${#OPTIONS[@]} )) ;;
        '[B') idx=$(( (idx + 1) % ${#OPTIONS[@]} )) ;;
        q)    tput cnorm 2>/dev/null || true; echo "已取消"; exit 0 ;;
        '')   break ;;
      esac
      printf '\033[%dA' "${#OPTIONS[@]}"
    done
    tput cnorm 2>/dev/null || true
    TARGETS=("${OPTION_DIRS[$idx]}")
  fi
fi

installed=0 skipped=0 removed=0
for dest_root in "${TARGETS[@]}"; do
  echo "== $dest_root"
  [ "$MODE" = "install" ] && mkdir -p "$dest_root"

  for skill_dir in "$SRC"/*/; do
    name="$(basename "$skill_dir")"
    src="$SRC/$name"
    dest="$dest_root/$name"

    if [ "$MODE" = "uninstall" ]; then
      if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$src" ]; then
        rm "$dest"
        echo "移除 $name"
        removed=$((removed + 1))
      fi
      continue
    fi

    if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$src" ]; then
      skipped=$((skipped + 1))
      continue
    fi
    if [ -e "$dest" ] || [ -L "$dest" ]; then
      echo "跳過 $name:$dest 已存在且不是指向本 repo 的 symlink,請自行處理" >&2
      skipped=$((skipped + 1))
      continue
    fi
    ln -s "$src" "$dest"
    echo "安裝 $name"
    installed=$((installed + 1))
  done
done

if [ "$MODE" = "uninstall" ]; then
  echo "完成:移除 $removed 個 symlink"
else
  echo "完成:新裝 $installed 個、略過 $skipped 個(已裝或位置被占用)"
fi
