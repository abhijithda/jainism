#!/bin/sh

set -eu

# Print usage instructions
show_help() {
    echo "Usage: $0 [branch_name] [media_option]"
    echo ""
    echo "Arguments:"
    echo "  branch_name    The GitHub branch to download (default: 'main')."
    echo "                 Branch names with a slash work too, e.g. staging/content-agent-test."
    echo "  media_option   Set to 'with-media' or 'all' to include images/audio."
    echo "                 (default: excludes media files)."
    echo ""
    echo "Output: tmp/jainism-<branch>.zip (a slash in the branch name becomes '-')."
    echo "  Set FORMAT=tar to get a .tar.gz instead. Without a 'zip' command the script uses"
    echo "  bsdtar (Windows tar) to make the zip, and only if neither is there, a .tar.gz."
    echo ""
    echo "Output: tmp/jainism-<branch>.zip (a slash in the branch name becomes '-')."
    echo "  Set FORMAT=tar to get a .tar.gz instead. Without a 'zip' command the script uses"
    echo "  bsdtar (Windows tar) to make the zip, and only if neither is there, a .tar.gz."
    echo ""
    echo "Options:"
    echo "  -h, -help, --help  Show this help message and exit."
    echo ""
    echo "Examples:"
    echo "  $0                                   # Bundles 'main' branch, excludes media"
    echo "  $0 develop                           # Bundles 'develop' branch, excludes media"
    echo "  $0 staging/content-agent-test        # Branch with a slash: file is jainism-staging-content-agent-test.zip"
    echo "  $0 main all                          # Bundles 'main' branch, includes all media"
    exit 0
}

# Check if the first argument is a help flag
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "-help" ] || [ "${1:-}" = "--help" ]; then
    show_help
fi

BRANCH="${1:-main}"
MEDIA_OPTION="${2:-exclude}"
FORMAT="${FORMAT:-zip}"
REPO="abhijithda/jainism"
TMP_DIR="tmp"

# A branch such as staging/content-agent-test has a slash. Use a flat name for the folder and the file,
# otherwise the folder becomes nested (staging/content-agent-test) and the archive path points into a folder that does not exist.
SAFE_NAME="$(printf '%s' "${BRANCH}" | tr '/\\: ' '----')"
OUT_BASE="$(basename "${REPO}")-${SAFE_NAME}"

mkdir -p "${TMP_DIR}"
cd "${TMP_DIR}"

# Start clean: a folder or archive left over from an earlier run would be mixed into this one
rm -rf "${SAFE_NAME}" "${OUT_BASE}.zip" "${OUT_BASE}.tar.gz"

# Download the branch into the flat folder name
npx --yes tiged "${REPO}#${BRANCH}" "${SAFE_NAME}"

if [ "${MEDIA_OPTION}" = "with-media" ] || [ "${MEDIA_OPTION}" = "all" ]; then
    INCLUDE_MEDIA=1
    echo "Bundling branch: ${BRANCH} (including all media files)"
else
    INCLUDE_MEDIA=0
    echo "Bundling branch: ${BRANCH} (excluding media files)"
fi

make_tar() {
    if [ "${INCLUDE_MEDIA}" = "1" ]; then
        tar -czf "${OUT_BASE}.tar.gz" "${SAFE_NAME}"
    else
        tar -czf "${OUT_BASE}.tar.gz" \
            --exclude="*.png" --exclude="*.jpg" --exclude="*.jpeg" --exclude="*.gif" --exclude="*.webp" \
            --exclude="*.mp4" --exclude="*.mp3" --exclude="notes" \
            "${SAFE_NAME}"
    fi
    echo "Created ${TMP_DIR}/${OUT_BASE}.tar.gz"
}

make_zip_with_zip() {
    if [ "${INCLUDE_MEDIA}" = "1" ]; then
        zip -r -q "${OUT_BASE}.zip" "${SAFE_NAME}"
    else
        zip -r -q "${OUT_BASE}.zip" "${SAFE_NAME}" \
            -x "*.png" "*.jpg" "*.jpeg" "*.gif" "*.webp" "*.mp4" "*.mp3" "${SAFE_NAME}/notes/*"
    fi
}

make_zip_with_bsdtar() {
    # Windows' own tar (bsdtar) writes a zip with -a and the .zip extension
    if [ "${INCLUDE_MEDIA}" = "1" ]; then
        tar -a -c -f "${OUT_BASE}.zip" "${SAFE_NAME}"
    else
        tar -a -c -f "${OUT_BASE}.zip" \
            --exclude="*.png" --exclude="*.jpg" --exclude="*.jpeg" --exclude="*.gif" --exclude="*.webp" \
            --exclude="*.mp4" --exclude="*.mp3" --exclude="${SAFE_NAME}/notes" \
            "${SAFE_NAME}"
    fi
}

if [ "${FORMAT}" = "tar" ]; then
    make_tar
elif command -v zip >/dev/null 2>&1; then
    make_zip_with_zip
    echo "Created ${TMP_DIR}/${OUT_BASE}.zip"
elif tar --version 2>/dev/null | grep -qi bsdtar; then
    make_zip_with_bsdtar
    echo "Created ${TMP_DIR}/${OUT_BASE}.zip"
else
    echo "No 'zip' command and no bsdtar found; making a .tar.gz instead."
    make_tar
fi

# Clean up the downloaded folder
rm -rf "${SAFE_NAME}"

cd ..
