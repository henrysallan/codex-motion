// Checks for the Instagram importer's parsing: run with `npm test`. The
// fixtures mirror the Relay JSON Instagram server-renders into its pages.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { describePost, normUrl, type PostContext, urlsIn } from '../instagram/enrich.ts';
import { mentions } from '../instagram/gather.ts';
import { isSocial } from '../instagram/links.ts';
import { findMedia, findUser, jsonBlocks, readCookies, redact } from '../instagram/pages.ts';
import { shortcodeOf, toInfo } from '../instagram/post.ts';

const script = (o: unknown) => `<script type="application/json" data-sjs>${JSON.stringify(o)}</script>`;

test('finds the shortcode in every post URL shape', () => {
  assert.equal(shortcodeOf('https://www.instagram.com/p/DewXkFYMRZS/'), 'DewXkFYMRZS');
  assert.equal(shortcodeOf('instagram.com/reel/DehjZdbx_nh?igsh=abc'), 'DehjZdbx_nh');
  assert.equal(shortcodeOf('https://www.instagram.com/poyin.work/p/DeOq2vtCVja/?img_index=2'), 'DeOq2vtCVja');
  assert.equal(shortcodeOf('https://www.instagram.com/reels/C1a2b3c4d5/'), 'C1a2b3c4d5');
  assert.equal(shortcodeOf('https://www.instagram.com/fabiocatapano/'), null);
  assert.equal(shortcodeOf('https://vimeo.com/123456789'), null);
});

test('reads caption mentions without trailing punctuation or emails', () => {
  assert.deepEqual(mentions('Identity for @dam_zub. Music by @Some.One, thanks @x_y!\nmail: me@example.com'), ['dam_zub', 'some.one', 'x_y']);
});

test('finds the post in the page JSON, tags from every slide included', () => {
  const html = script({ require: [['x', { __bbox: { result: { data: { xig_polaris_media: { if_not_gated_logged_out: {
    code: 'ABCDEF1', pk: '1', taken_at: 1791887309, media_type: 8, product_type: 'carousel_container',
    caption: { text: 'Stigmergy @cavalry.app' },
    user: { username: 'maker', full_name: 'A Maker' },
    coauthor_producers: [{ username: 'studio', full_name: 'The Studio', is_verified: true }],
    usertags: { in: [{ user: { username: 'friend' } }] },
    carousel_media: [{ media_type: 2, original_width: 1080, original_height: 1350, usertags: { in: [{ user: { username: 'composer', full_name: 'C' } }] } }, { media_type: 1 }],
    clips_metadata: { music_info: { music_asset_info: { title: 'Kaasu', display_artist: 'Pan Sonic' } } },
    location: { name: 'London, England' },
    like_count: 5,
  } } } } } }]] }) + script({ unrelated: true }) + '<script type="application/json">{not json</script>';
  const m = findMedia(jsonBlocks(html), 'ABCDEF1');
  assert.ok(m);
  assert.equal(m.caption, 'Stigmergy @cavalry.app');
  assert.equal(m.takenAt, '2026-10-13T10:28:29.000Z');
  assert.deepEqual(m.user, { username: 'maker', fullName: 'A Maker' });
  assert.deepEqual(m.coauthors, [{ username: 'studio', fullName: 'The Studio', verified: true }]);
  assert.deepEqual(m.tagged.map((u) => u.username), ['friend', 'composer']);
  assert.deepEqual(m.music, { title: 'Kaasu', artist: 'Pan Sonic' });
  assert.equal(m.location, 'London, England');
  assert.equal(m.slides?.length, 2);
  assert.equal(findMedia(jsonBlocks(html), 'OTHER12'), null);
});

test('finds the profile, logged out (edges) or logged in (counts)', () => {
  const out = findUser([{ data: { user: { username: 'Rettlesnake', full_name: 'Sergey Shurupov', biography: 'Hi — mail me at s@studio.com or +44 20 7946 0958', bio_links: [{ title: 'Site', url: 'http://rettlesnake.com/' }], external_url: 'http://rettlesnake.com/', edge_followed_by: { count: 1200 } } } }], 'rettlesnake');
  assert.ok(out);
  assert.equal(out.fullName, 'Sergey Shurupov');
  assert.equal(out.biography, 'Hi — mail me at [email] or [phone]');
  assert.deepEqual(out.links, [{ title: 'Site', url: 'http://rettlesnake.com/' }]);
  assert.equal(out.followers, 1200);
  const inside = findUser([{ user: { username: 'x', biography: '', category_name: 'Artist', follower_count: 9, media_count: 3, is_business: true } }], 'x');
  assert.deepEqual({ category: inside?.category, followers: inside?.followers, posts: inside?.posts, business: inside?.business }, { category: 'Artist', followers: 9, posts: 3, business: true });
  // A user object without a bio is a mention elsewhere on the page, not the profile.
  assert.equal(findUser([{ user: { username: 'x', full_name: 'X' } }], 'x'), null);
});

test('redacts contact details in bios', () => {
  assert.equal(redact('Business email: theditingco@gmail.com\nget the project file'), 'Business email: [email]\nget the project file');
  assert.equal(redact('ART + DESIGN & ECD @brandnewschool'), 'ART + DESIGN & ECD @brandnewschool');
  assert.equal(redact('Motion designer 2018-2026 · call (415) 555-0134'), 'Motion designer 2018-2026 · call [phone]');
});

test('reads cookies.txt, Chrome-epoch expiry included', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ig-')), 'c.txt');
  fs.writeFileSync(file, '# Netscape HTTP Cookie File\n.instagram.com\tTRUE\t/\tTRUE\t13468977571680372\tsessionid\tabc\n#HttpOnly_.instagram.com\tTRUE\t/\tTRUE\t1800000000\tds_user_id\t42\n.instagram.com\tTRUE\t/\tFALSE\t0\trur\tx\n');
  const c = readCookies(file);
  assert.deepEqual(c.map((x) => [x.name, x.expires, x.httpOnly, x.secure]), [['sessionid', 1824503971, false, true], ['ds_user_id', 1800000000, true, true], ['rur', undefined, false, false]]);
});

test('keeps what yt-dlp says about a carousel, minus its formats', () => {
  const info = toInfo({ id: 'X', channel: 'maker', description: 'cap', comments: [{ author: 'maker', text: 'made in houdini', parent: 'c1' }], entries: [
    { id: 'a', formats: [{ vcodec: 'vp9', width: 720, height: 900 }, { vcodec: 'vp9', width: 1080, height: 1350 }] },
    { id: 'b', formats: [{ vcodec: 'none' }] },
  ] });
  assert.deepEqual(info.videos, [{ id: 'a', index: 1, width: 1080, height: 1350 }]);
  assert.deepEqual(info.comments, [{ author: 'maker', text: 'made in houdini', reply: true }]);
});

test('describes only the layers asked for, and collects the URLs it shows', () => {
  const ctx: PostContext = {
    code: 'X', url: 'https://www.instagram.com/p/X/',
    info: { id: 'X', channel: 'maker', description: 'Stigmergy', comments: [{ author: 'maker', text: 'Cavalry!' }], videos: [] },
    poster: { username: 'maker', fullName: 'A Maker', biography: 'designer', links: [{ url: 'http://www.maker.it' }] },
    related: [],
    links: [{ url: 'http://www.maker.it', finalUrl: 'https://maker.it/', title: 'A Maker – Designer' }],
  };
  const post = describePost(ctx, new Set(['post']));
  assert.match(post, /Caption:\nStigmergy/);
  assert.match(post, /The poster's own comments:\n- Cavalry!/);
  assert.doesNotMatch(post, /designer|maker\.it/);
  const full = describePost(ctx, new Set(['post', 'profile', 'links']));
  assert.match(full, /bio links: http:\/\/www\.maker\.it/);
  assert.match(full, /title: A Maker – Designer/);
  assert.ok(urlsIn(full).has(normUrl('https://maker.it')));
  assert.equal(normUrl('HTTP://www.Maker.it/'), 'maker.it');
});

test('knows which bio links a plain request can read', () => {
  assert.equal(isSocial('https://x.com/garments__'), true);
  assert.equal(isSocial('https://www.behance.net/katyashevchun'), false);
});
