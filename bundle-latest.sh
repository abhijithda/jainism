#!/bin/sh

set -eu

# Print usage instructions
show_help() {
    echo "Usage: $0 [branch_name] [media_option]"
    echo ""
    echo "Arguments:"
    echo "  branch_name    The GitHub branch to download (default: 'main')."
    echo "  media_option   Set to 'with-media' or 'all' to include images/audio."
    echo "                 (default: excludes media files)."
    echo ""
    echo "Options:"
    echo "  -h, -help, --help  Show this help message and exit."
    echo ""
    echo "Examples:"
    echo "  $0                  # Bundles 'main' branch, excludes media"
    echo "  $0 develop          # Bundles 'develop' branch, excludes media"
    echo "  $0 main all       # Bundles 'main' branch, includes all media"
    exit 0
}

# Check if the first argument is a help flag
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "-help" ] || [ "${1:-}" = "--help" ]; then
    show_help
fi

BRANCH="${1:-main}"
MEDIA_OPTION="${2:-exclude}"
REPO="abhijithda/jainism"
TMP_DIR="tmp"

mkdir -p "${TMP_DIR}"
cd "${TMP_DIR}"

# Download the specific folder from the branch
npx --yes tiged "${REPO}#${BRANCH}" "${BRANCH}"

# Build and execute the tar command based on the media option
if [ "${MEDIA_OPTION}" = "with-media" ] || [ "${MEDIA_OPTION}" = "all" ]; then
    echo "Bundling branch: ${BRANCH} (including all media files)"
    tar -czf "pooja-${BRANCH}.tar.gz" "${BRANCH}"
else
    echo "Bundling branch: ${BRANCH} (excluding media files)"
    tar -czf "pooja-${BRANCH}.tar.gz" \
        --exclude="*.png" \
        --exclude="*.jpg" \
        --exclude="*.jpeg" \
        --exclude="*.gif" \
        --exclude="*.webp" \
        --exclude="*.mp4" \
        --exclude="*.mp3" \
        "${BRANCH}"
fi

# Clean up the downloaded folder
rm -rf "${BRANCH}"

cd ..
