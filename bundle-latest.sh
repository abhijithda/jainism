#!/bin/sh

set -eu

# Print usage instructions
show_help() {
    echo "Usage: $0 [branch_name] [media_option]"
    echo ""
    echo "Arguments:"
    echo "  branch_name    The GitHub branch to download (default: 'main')."
    echo "                 Branch names with a slash work too, e.g. staging/content-agent-test."
    echo "  media_option   Set to 'with-media' or 'all' to include images/audio and the notes/ folder."
    echo "                 (default: leaves them out)."
    echo ""
    echo "Output: tmp/jainism-<branch>.zip (a slash in the branch name becomes '-')."
    echo "  The zip is the default. FORMAT=tar gives a .tar.gz instead. Without a 'zip' command the"
    echo "  script uses bsdtar (Windows' own tar) to make the zip, and only if neither is there, a .tar.gz."
    echo "  Inside the zip, BUNDLE-INFO.txt says which branch and commit it holds and what is left out,"
    echo "  and FILES-LEFT-OUT.txt lists every file that was left out."
    echo ""
    echo "Options:"
    echo "  -h, -help, --help  Show this help message and exit."
    echo ""
    echo "Examples:"
    echo "  $0                                   # Bundles 'main' branch, leaves media out"
    echo "  $0 develop                           # Bundles 'develop' branch, leaves media out"
    echo "  $0 staging/content-agent-test        # Branch with a slash: file is jainism-staging-content-agent-test.zip"
    echo "  $0 main all                          # Bundles 'main' branch, includes all media"
    echo "  FORMAT=tar $0                        # Same as the first, as a .tar.gz"
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

# A branch such as staging/content-agent-test has a slash. Use a flat name for the folder and the file, otherwise the
# folder becomes nested (staging/content-agent-test) and the archive path points into a folder that does not exist.
SAFE_NAME="$(printf '%s' "${BRANCH}" | tr '/\\: ' '----')"
# Every rm below is written "${SAFE_NAME:?}/..." so an empty name stops the script instead of turning into "/notes".
: "${SAFE_NAME:?the branch name gave an empty folder name}"
OUT_BASE="$(basename "${REPO}")-${SAFE_NAME}"

mkdir -p "${TMP_DIR}"
cd "${TMP_DIR}"

# Start clean: a folder or archive left over from an earlier run would be mixed into this one
rm -rf "${SAFE_NAME:?}" "${OUT_BASE}.zip" "${OUT_BASE}.tar.gz"

# Download the branch into the flat folder name
npx --yes tiged "${REPO}#${BRANCH}" "${SAFE_NAME}"

if [ "${MEDIA_OPTION}" = "with-media" ] || [ "${MEDIA_OPTION}" = "all" ]; then
    INCLUDE_MEDIA=1
    echo "Bundling branch: ${BRANCH} (including all media files)"
else
    INCLUDE_MEDIA=0
    echo "Bundling branch: ${BRANCH} (leaving media files and notes/ out)"
fi

# Two small text files go into the bundle, so whoever reads it knows exactly what it is and what is not in it.
COMMIT="$(git ls-remote "https://github.com/${REPO}.git" "refs/heads/${BRANCH}" 2>/dev/null | cut -c1-12 || true)"
{
    echo "branch:     ${BRANCH}"
    echo "commit:     ${COMMIT:-unknown}  (what is pushed on GitHub; changes that are not pushed are NOT in this bundle)"
    echo "bundled:    $(date -u +%Y-%m-%dT%H:%MZ)"
    if [ "${INCLUDE_MEDIA}" = "1" ]; then
        echo "left out:   nothing (with-media)"
    else
        echo "left out:   image and media files (*.png *.jpg *.jpeg *.gif *.webp *.mp4 *.mp3: assets/images, the e2e screenshot"
        echo "            baselines, pictures in notes/) and the notes/ folder; the list is in FILES-LEFT-OUT.txt"
        echo "            unit tests that need the images (data, thumbnails, og-image) and the offline e2e tests fail without them"
    fi
    echo "not in any bundle: repository secrets and variables (GEMINI_API_KEY, GEMINI_MODELS ...), Actions logs, PR comments"
} > "${SAFE_NAME:?}/BUNDLE-INFO.txt"

# The downloaded folder is a temporary copy (it is removed at the end), so the files that are left out are simply deleted from
# it before archiving. That behaves the same for zip, bsdtar and tar, with no exclude patterns whose meaning differs per tool.
if [ "${INCLUDE_MEDIA}" = "0" ]; then
    # a record of what is left out (size in bytes, path), made before anything is deleted
    find "${SAFE_NAME:?}" -type f \( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' -o -name '*.gif' -o -name '*.webp' -o -name '*.mp4' -o -name '*.mp3' -o -path "${SAFE_NAME:?}/notes/*" \) \
        -exec wc -c {} + 2>/dev/null | grep -v ' total$' | sed "s#${SAFE_NAME}/##" | sort -k2 > "${SAFE_NAME:?}/FILES-LEFT-OUT.txt" || true
    find "${SAFE_NAME:?}" -type f \( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' -o -name '*.gif' -o -name '*.webp' -o -name '*.mp4' -o -name '*.mp3' \) -exec rm -f {} +
    rm -rf "${SAFE_NAME:?}/notes"
    # folders that only held media are now empty; drop them so the archive has no empty media folders
    find "${SAFE_NAME:?}" -type d -empty -exec rmdir {} + 2>/dev/null || true
fi

make_tar() {
    tar -czf "${OUT_BASE}.tar.gz" "${SAFE_NAME:?}"
    echo "Created ${TMP_DIR}/${OUT_BASE}.tar.gz"
}

make_zip_with_zip() {
    zip -r -q "${OUT_BASE}.zip" "${SAFE_NAME:?}"
}

make_zip_with_bsdtar() {
    # Windows' own tar (bsdtar) writes a zip with -a and the .zip extension
    tar -a -c -f "${OUT_BASE}.zip" "${SAFE_NAME:?}"
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
rm -rf "${SAFE_NAME:?}"

cd ..
