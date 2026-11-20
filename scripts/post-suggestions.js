#!/usr/bin/env node
// post-suggestions.js — put the typo review's doubtful cases on the Pull Request as one-click suggestions.
//
//   node scripts/post-suggestions.js --pr 12 --sha <head commit> --file suggestions.json
//   needs GITHUB_TOKEN and GITHUB_REPOSITORY (both set inside GitHub Actions)
//
// A suggestion already on the PR (same <!-- typo:hash --> marker) is not posted again, so running the review twice does
// not pile up duplicates. If GitHub refuses a line (it is not part of the PR's diff) that suggestion goes into one
// ordinary comment instead, so nothing is lost.
const fs = require('fs');

const API = 'https://api.github.com';
const markerOf = (body) => (String(body).match(/<!-- typo:([0-9a-f]+) -->/) || [])[1];

/** Pure: the comments whose marker is not already on the PR. */
function onlyNew(comments, existingBodies) {
    const have = new Set(existingBodies.map(markerOf).filter(Boolean));
    return comments.filter((c) => !have.has(c.hash || markerOf(c.body)));
}

async function postSuggestions({ fetchImpl = fetch, repo, pr, sha, token, comments }) {
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' };
    const call = async (method, url, body) => {
        const res = await fetchImpl(`${API}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
        const json = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, json };
    };
    const existing = [];
    for (let page = 1; page <= 10; page++) {
        const r = await call('GET', `/repos/${repo}/pulls/${pr}/comments?per_page=100&page=${page}`);
        if (!r.ok || !Array.isArray(r.json) || !r.json.length) break;
        existing.push(...r.json.map((c) => c.body));
        if (r.json.length < 100) break;
    }
    const fresh = onlyNew(comments, existing);
    if (!fresh.length) return { posted: 0, skipped: comments.length, fallback: 0 };
    const payload = (list) => list.map(({ path, line, side, body }) => ({ path, line, side, body }));
    const review = await call('POST', `/repos/${repo}/pulls/${pr}/reviews`, {
        commit_id: sha, event: 'COMMENT', body: `Typo review: ${fresh.length} doubtful case(s). Nothing was changed for these; press *Commit suggestion* on the ones you agree with.`, comments: payload(fresh),
    });
    if (review.ok) return { posted: fresh.length, skipped: comments.length - fresh.length, fallback: 0 };
    // one or more lines are not in the diff: try one by one, collect what GitHub refuses
    let posted = 0;
    const refused = [];
    for (const c of fresh) {
        const r = await call('POST', `/repos/${repo}/pulls/${pr}/reviews`, { commit_id: sha, event: 'COMMENT', body: '', comments: payload([c]) });
        if (r.ok) posted++; else refused.push(c);
    }
    if (refused.length) {
        const text = refused.map((c) => `- \`${c.path}\` line ${c.line}\n${c.body.replace(/<!--.*?-->/g, '')}`).join('\n\n');
        await call('POST', `/repos/${repo}/issues/${pr}/comments`, { body: `Typo review: ${refused.length} suggestion(s) could not be attached to a line of the diff:\n\n${text}\n\n${refused.map((c) => `<!-- typo:${c.hash} -->`).join('')}` });
    }
    return { posted, skipped: comments.length - fresh.length, fallback: refused.length };
}

module.exports = { onlyNew, markerOf, postSuggestions };

if (require.main === module) {
    const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
    const comments = JSON.parse(fs.readFileSync(arg('--file') || 'suggestions.json', 'utf8'));
    if (!comments.length) { console.log('No suggestions to post.'); process.exit(0); }
    postSuggestions({ repo: process.env.GITHUB_REPOSITORY, pr: arg('--pr'), sha: arg('--sha'), token: process.env.GITHUB_TOKEN, comments })
        .then((r) => console.log(`Suggestions: ${r.posted} posted, ${r.skipped} already there, ${r.fallback} as a plain comment.`))
        .catch((e) => { console.error(`post-suggestions: ${e.message}`); process.exit(1); });
}
