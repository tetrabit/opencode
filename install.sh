#!/usr/bin/env bash
set -euo pipefail
APP=opencode

MUTED='\033[0;2m'
RED='\033[0;31m'
ORANGE='\033[38;5;214m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
    cat <<EOF
OpenCode Local Installer — compiles and installs from source

Usage: ./install.sh [options]

Options:
    -h, --help              Display this help message
        --no-modify-path    Don't modify shell config files (.zshrc, .bashrc, etc.)
        --skip-deps         Skip 'bun install' (use if deps are already installed)

Examples:
    ./install.sh
    ./install.sh --no-modify-path
    ./install.sh --skip-deps
EOF
}

no_modify_path=false
skip_deps=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            usage
            exit 0
            ;;
        --no-modify-path)
            no_modify_path=true
            shift
            ;;
        --skip-deps)
            skip_deps=true
            shift
            ;;
        *)
            echo -e "${ORANGE}Warning: Unknown option '$1'${NC}" >&2
            shift
            ;;
    esac
done

INSTALL_DIR=$HOME/.opencode/bin
mkdir -p "$INSTALL_DIR"

# --- Detect platform for build output path ---
raw_os=$(uname -s)
case "$raw_os" in
    Darwin*) os="darwin" ;;
    Linux*)  os="linux" ;;
    MINGW*|MSYS*|CYGWIN*) os="windows" ;;
    *) echo -e "${RED}Unsupported OS: $raw_os${NC}"; exit 1 ;;
esac

arch=$(uname -m)
case "$arch" in
    aarch64) arch="arm64" ;;
    x86_64)  arch="x64" ;;
esac

if [ "$os" = "darwin" ] && [ "$arch" = "x64" ]; then
    rosetta_flag=$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)
    if [ "$rosetta_flag" = "1" ]; then
        arch="arm64"
    fi
fi

target="${os}-${arch}"
dist_name="${APP}-${target}"
build_script="${SCRIPT_DIR}/packages/opencode/script/build.ts"
binary_path="${SCRIPT_DIR}/packages/opencode/dist/${dist_name}/bin/opencode"

# --- Verify prerequisites ---
print_message() {
    local level=$1
    local message=$2
    local color=""
    case $level in
        info)    color="${NC}" ;;
        warning) color="${ORANGE}" ;;
        error)   color="${RED}" ;;
        success) color="${GREEN}" ;;
    esac
    echo -e "${color}${message}${NC}"
}

if ! command -v bun >/dev/null 2>&1; then
    print_message error "Error: 'bun' is required but not installed."
    print_message info "${MUTED}Install bun: ${NC}curl -fsSL https://bun.sh/install | bash"
    exit 1
fi

bun_version=$(bun --version 2>/dev/null)
print_message info "${MUTED}Using bun ${NC}${bun_version}"

if [ ! -f "$build_script" ]; then
    print_message error "Error: Build script not found at ${build_script}"
    print_message info "${MUTED}Are you running this from the opencode repo root?${NC}"
    exit 1
fi

# --- Fetch & pull latest from origin ---
if command -v git >/dev/null 2>&1 && git -C "$SCRIPT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    current_branch=$(git -C "$SCRIPT_DIR" symbolic-ref --short HEAD 2>/dev/null || echo "")
    if [ -n "$current_branch" ]; then
        print_message info "\n${MUTED}Fetching latest from origin...${NC}"
        if git -C "$SCRIPT_DIR" fetch origin 2>/dev/null; then
            local_head=$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null)
            remote_head=$(git -C "$SCRIPT_DIR" rev-parse "origin/${current_branch}" 2>/dev/null || echo "")

            if [ -z "$remote_head" ]; then
                print_message warning "${MUTED}No remote tracking branch ${NC}origin/${current_branch}${MUTED}, skipping pull${NC}"
            elif [ "$local_head" = "$remote_head" ]; then
                print_message info "${MUTED}Already up to date on ${NC}${current_branch}"
            else
                # Check for uncommitted changes that would block a pull
                if git -C "$SCRIPT_DIR" diff-index --quiet HEAD -- 2>/dev/null; then
                    print_message info "${MUTED}Pulling latest on ${NC}${current_branch}${MUTED}...${NC}"
                    if git -C "$SCRIPT_DIR" pull --ff-only origin "$current_branch" 2>/dev/null; then
                        print_message info "${GREEN}Updated to $(git -C "$SCRIPT_DIR" rev-parse --short HEAD)${NC}"
                    else
                        print_message warning "${MUTED}Fast-forward pull failed (diverged history?), building current tree${NC}"
                    fi
                else
                    print_message warning "${MUTED}Uncommitted changes detected, skipping pull — building current tree${NC}"
                fi
            fi
        else
            print_message warning "${MUTED}Fetch failed (offline?), building current tree${NC}"
        fi
    fi
else
    print_message warning "${MUTED}Not a git repo or git not found, skipping update check${NC}"
fi

# --- Install dependencies ---
if [ "$skip_deps" = "false" ]; then
    print_message info "\n${MUTED}Installing dependencies...${NC}"
    cd "$SCRIPT_DIR"
    bun install
else
    print_message info "\n${MUTED}Skipping dependency install (--skip-deps)${NC}"
fi

# --- Build ---
print_message info "\n${MUTED}Building ${NC}opencode ${MUTED}for ${NC}${target}${MUTED}...${NC}"
cd "$SCRIPT_DIR"
"$build_script" --single

if [ ! -f "$binary_path" ]; then
    print_message error "Error: Build succeeded but binary not found at ${binary_path}"
    exit 1
fi

# --- Smoke test ---
built_version=$("$binary_path" --version 2>/dev/null || echo "unknown")
print_message info "${MUTED}Built version: ${NC}${built_version}"

# --- Install ---
print_message info "${MUTED}Installing to ${NC}${INSTALL_DIR}/opencode"
cp "$binary_path" "${INSTALL_DIR}/opencode"
chmod 755 "${INSTALL_DIR}/opencode"

# --- PATH setup ---
add_to_path() {
    local config_file=$1
    local command=$2

    if grep -Fxq "$command" "$config_file"; then
        print_message info "Command already exists in $config_file, skipping write."
    elif [[ -w $config_file ]]; then
        echo -e "\n# opencode" >> "$config_file"
        echo "$command" >> "$config_file"
        print_message info "${MUTED}Successfully added ${NC}opencode ${MUTED}to \$PATH in ${NC}$config_file"
    else
        print_message warning "Manually add the directory to $config_file (or similar):"
        print_message info "  $command"
    fi
}

XDG_CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}

current_shell=$(basename "$SHELL")
case $current_shell in
    fish)
        config_files="$HOME/.config/fish/config.fish"
    ;;
    zsh)
        config_files="${ZDOTDIR:-$HOME}/.zshrc ${ZDOTDIR:-$HOME}/.zshenv $XDG_CONFIG_HOME/zsh/.zshrc $XDG_CONFIG_HOME/zsh/.zshenv"
    ;;
    bash)
        config_files="$HOME/.bashrc $HOME/.bash_profile $HOME/.profile $XDG_CONFIG_HOME/bash/.bashrc $XDG_CONFIG_HOME/bash/.bash_profile"
    ;;
    ash)
        config_files="$HOME/.ashrc $HOME/.profile /etc/profile"
    ;;
    sh)
        config_files="$HOME/.ashrc $HOME/.profile /etc/profile"
    ;;
    *)
        config_files="$HOME/.bashrc $HOME/.bash_profile $XDG_CONFIG_HOME/bash/.bashrc $XDG_CONFIG_HOME/bash/.bash_profile"
    ;;
esac

if [[ "$no_modify_path" != "true" ]]; then
    config_file=""
    for file in $config_files; do
        if [[ -f $file ]]; then
            config_file=$file
            break
        fi
    done

    if [[ -z $config_file ]]; then
        print_message warning "No config file found for $current_shell. You may need to manually add to PATH:"
        print_message info "  export PATH=$INSTALL_DIR:\$PATH"
    elif [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
        case $current_shell in
            fish)
                add_to_path "$config_file" "fish_add_path $INSTALL_DIR"
            ;;
            *)
                add_to_path "$config_file" "export PATH=$INSTALL_DIR:\$PATH"
            ;;
        esac
    fi
fi

if [ -n "${GITHUB_ACTIONS-}" ] && [ "${GITHUB_ACTIONS}" == "true" ]; then
    echo "$INSTALL_DIR" >> "$GITHUB_PATH"
    print_message info "Added $INSTALL_DIR to \$GITHUB_PATH"
fi

echo -e ""
echo -e "${MUTED}                    ${NC}             ▄     "
echo -e "${MUTED}█▀▀█ █▀▀█ █▀▀█ █▀▀▄ ${NC}█▀▀▀ █▀▀█ █▀▀█ █▀▀█"
echo -e "${MUTED}█░░█ █░░█ █▀▀▀ █░░█ ${NC}█░░░ █░░█ █░░█ █▀▀▀"
echo -e "${MUTED}▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀  ▀ ${NC}▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀"
echo -e ""
echo -e "${GREEN}Installed from source${NC} ${MUTED}(${NC}${built_version}${MUTED})${NC}"
echo -e ""
echo -e "${MUTED}To start:${NC}"
echo -e ""
echo -e "cd <project>  ${MUTED}# Open directory${NC}"
echo -e "opencode      ${MUTED}# Run command${NC}"
echo -e ""
