// /guide — the field guide: trail view, list view and the treasure at the end.
// Content mirrors the in-app tutorial deck. Screenshots live in /site/img/guide/.
(function () {
  'use strict';
  function im(name, alt) { return { src: '/site/img/guide/' + name + '.webp', alt: alt }; }
  var SITES = [
  { name: 'Base Camp', pages: [
    { title: 'One button saves the fight from every view', points: [['Buffer.', 'Peakabu keeps a rolling recording of your screen on your own PC while you play.'], ['Save.', 'Anyone in the session hits Save. Every recording member’s last few seconds are clipped at the same moment.'], ['Upload.', 'Each clip is saved to your video folder and uploaded to the session.'], ['Watch.', 'The web player lines up every point of view so the squad can rewatch the play together.']], tip: 'The rolling buffer stays on your PC. Only clips that get saved are uploaded.', imgs: [] },
    { title: 'Install and first launch', points: [['Download', 'the Windows installer from peakabu.app and run it. The file is named peak-abu-setup followed by the version number.'], ['Welcome screen:', 'the first launch shows where videos will be saved. Use Choose Video Storage Folder to change it, then Get Started.'], ['Updates', 'download in the background. A banner then offers Restart & Update, or Later to install on the next launch.']], tip: 'If Windows shows a “protected your PC” prompt, choose More info, then Run anyway. Pick a drive with free space for videos.', imgs: [im('install-welcome', 'First-launch welcome screen showing the app location, video storage folder, Choose Video Storage Folder and Get Started'), im('install-update', 'Update banner with Restart and Update and Later buttons')] },
    { title: 'Create your account', points: [['Choose “I’m new here”', 'at the top of the Account box.'], ['Username:', '2 to 24 characters, using letters, numbers, underscore or dash.'], ['Password:', 'at least 8 characters, typed twice to confirm.'], ['Tick the agreement', 'to the Terms of Service and Privacy Policy.'], ['Create Account', 'lights up once everything is filled in. The line under it lists what is still missing.']], tip: 'Your username is what squadmates see in sessions and on your clips in the web player.', imgs: [im('signup', 'Account box on the I’m new here tab with username, password, confirm password and terms checkbox')] },
    { title: 'Log in', points: [['“I have an account”', 'is the tab for returning users. Enter your username and password, then Log In.'], ['You stay logged in', 'between launches, so you normally only do this once per PC.'], ['Forgot password?', 'opens the reset page on peakabu.app, where you confirm it’s you with your linked Discord.'], ['Redeem and Settings', 'sit in the top right on every screen. The version number is under the Peakabu name.']], tip: 'If the app says your session expired, just log in again. Your saved videos and settings are untouched.', imgs: [im('login', 'Account box on the I have an account tab with username and password fields and a Log In button')] }
  ] },
  { name: 'The Canopy', pages: [
    { title: 'Four panels do everything', points: [['Squad Session:', 'create a session, join a friend’s, or rejoin your last one.'], ['Highlight:', 'the Save button, its hotkeys, and controller save.'], ['Recording:', 'start and stop capture, and choose what gets recorded.'], ['Session HUD:', 'a running log, your session history, and the upload queue.'], ['The top bar', 'shows who is logged in and your plan, with Log Out on the right.']], tip: 'The small arrow beside each panel title collapses it. Clicking the monkey by the Peakabu name collapses or opens all of them.', imgs: [im('tour', 'Main window after login showing the Squad Session, Highlight and Recording panels')] },
    { title: 'Redeem a code to change your plan', points: [['Click Redeem', 'in the top right, type or paste your code, then Activate or press Enter.'], ['Codes look like', 'PA-T3-XXXXXXXX. A message under the button confirms it worked or says why it did not.'], ['Your plan shows', 'beside your name in the top bar, along with days remaining when a plan has an end date.'], ['Plans change', 'squad size, how long clips are kept, and access to Auto-Highlight and AI Reel.']], tip: 'Session limits follow the host’s plan, so a squad gets the benefits of whoever created the session.', imgs: [im('redeem', 'Redeem a code panel open under the Redeem button with a code field and Activate button')] },
    { title: 'Start a session and bring the squad in', points: [['Create New Session', 'makes you the host and shows a six-character code. Click the code to copy it.'], ['The link icon', 'beside the code copies an invite link. Friends who click it open Peakabu and join.'], ['To join instead,', 'type a friend’s code under “or join a friend” and press Join Session.'], ['The Squad list', 'shows each member as REC or Idle. Hosts can hover a member’s status to kick or ban them.'], ['The bar above Leave Session', 'shows clip time used out of the session’s total.']], tip: 'When the host leaves, the session closes for everyone. Rejoin Session on the start screen reopens your last hosted session.', imgs: [im('squad', 'Squad Session panel showing a session code, the invite link icon, Open in Web Player, a squad member and Leave Session')] },
    { title: 'Start the rolling buffer before you play', points: [['Start Highlight Session', 'begins recording. The first time, you confirm that you understand your screen and mic are recorded.'], ['Status goes', 'from Idle to Buffering, then to Ready after about 15 seconds. Save only works once it says Ready.'], ['Monitor, Framerate, Quality and Color', 'set what is captured: 30 or 60 FPS, and Native, 720p or 480p.'], ['Full Session Mode', 'also keeps the entire recording on your PC when you end. Highlights still upload as normal.'], ['End Session', 'stops recording. It does not leave the squad session.']], tip: 'Full Session Mode uses roughly 0.5 to 1 GB per 10 minutes at 1080p. To switch monitors, end the session and start again.', imgs: [im('recording', 'Session HUD, Highlight and Recording panels, with the Start Highlight Session button and capture settings')] },
    { title: 'Capture Mode: whole monitor or one game window', points: [['Monitor (recommended)', 'records everything on the chosen screen. It works with every game, including exclusive fullscreen.'], ['Game Window (Beta)', 'records a single window. Press Pick Window and choose your game from the thumbnails.'], ['Game Window needs', 'a borderless or windowed game. Tick “Show all windows” if your game is not listed.']], tip: 'Cap your game’s frame rate in either mode. An unlimited frame rate leaves no graphics power for recording.', imgs: [im('capture', 'Recording panel with the Capture Mode hover tip')] },
    { title: 'The microphone button: mic and game audio', points: [['Microphone:', 'pick which mic goes into your clips, or None to record game audio only.'], ['Volume and Mute', 'change how loud your voice is in the recording. Mute works mid-session.'], ['Noise Suppression', 'removes fan and keyboard noise. Auto gives the best quality; RNNoise is the lightest; Off leaves the mic raw.'], ['Game audio', 'is whatever plays on your Windows default output device.']], tip: 'To record a different speaker or headset, change the default output in Windows sound settings, not in Peakabu.', imgs: [im('audio', 'Audio menu open over the Recording panel with microphone choice, volume, mute, noise suppression and game audio device')] },
    { title: 'Save a highlight for the whole squad', points: [['Press Save Highlight', 'or your hotkey right after the play. It keeps the footage that just happened.'], ['One press covers everyone.', 'Every member who is recording gets a clip of the same moment from their own screen.'], ['Clip length', 'is set by the host in the box beside Save: 15s, 30s, 1min or 3min.'], ['After a save,', 'the button counts down while the buffer refills, then returns to Ready.']], tip: 'A member who is not recording gets no clip. Check everyone shows REC in the Squad list before the match starts.', imgs: [im('save', 'Highlight panel with the Save Highlight button and the clip length menu open')] },
    { title: 'Hotkeys and controller save', points: [['Keyboard icon:', 'the save hotkey. Click it, then press the key you want while it says “Listening”.'], ['Star icon:', 'the star hotkey, for marking a highlight as a favourite so it is easy to find in the player.'], ['Allowed keys:', 'an F-key on its own, or Ctrl, Alt or Shift plus another key. Esc cancels.'], ['Controller Save:', 'pick a button, then Double-press or Long-press so normal play does not trigger it.']], tip: 'Pick a key your game does not use. If another program already owns the key, Peakabu keeps your old one and tells you.', imgs: [im('hotkeys', 'Highlight panel with the hotkey box listening for a key and the Controller Save menus')] },
    { title: 'Auto-Highlight saves loud moments for you', points: [['Turn it on', 'in Settings, General. It is off by default and set per PC. It needs the Creator plan or higher.'], ['It listens', 'for audio that is much louder than the last minute or so of play, then records until things go quiet.'], ['Sensitivity:', 'Low catches only the biggest moments, High catches more. Start on Medium.'], ['Desktop and Mic', 'choose what it listens to. Your voice can extend a capture but cannot start one.'], ['While it is capturing,', 'Save becomes “Save Auto-Capture Now” to cut the clip at that point.']], tip: 'The two monkeys on the Recording panel show it working. They brighten on a loud sound and pulse while a capture is open.', imgs: [im('auto-on', 'Auto-Highlight Detection switched on with Sensitivity Medium and Desktop and Mic on'), im('auto-sensitivity', 'Sensitivity menu open showing Low, Medium and High'), im('auto-monkeys', 'Recording panel header with two monkey icons beside the microphone button')] },
    { title: 'Six HUD tabs tell you what just happened', points: [['Activity', '(lightning): saves, uploads and clock sync.'], ['My Hosted Sessions', '(crown): sessions you created, with the game and when clips expire.'], ['History', '(clipboard): every session you hosted or joined.'], ['Squad', '(people): who joined, left or was removed.'], ['System', '(tools): app messages and warnings.'], ['Upload Queue', '(outbox): see the next page.']], tip: 'A number on a tab means unread messages. In the history tabs, click a row to copy its code, or the globe to open it in the player.', imgs: [im('hud', 'Main window with the Session HUD on the Activity tab')] },
    { title: 'Upload Queue and Low Bandwidth Mode', points: [['Low Bandwidth Mode', 'stops clip uploads from spiking your ping. Clips wait until the fight is over, then upload.'], ['Auto', 'turns it on only when your upload speed is slow. On and Off force it either way.'], ['The speed line', 'shows your measured upload speed. Retest runs the check again.'], ['Sync', 'looks for clips on your PC that never reached the session and sends them.'], ['Your Clips', 'lists anything still waiting to upload.']], tip: 'Close Peakabu with clips still queued and it offers to minimise and keep uploading. Missing a clip in the player? Press Sync.', imgs: [im('uploads', 'Upload Queue tab with Low Bandwidth Mode buttons, upload speed and Your Clips list')] }
  ] },
  { name: 'The Workshop', pages: [
    { title: 'General: storage, Discord and the big switches', points: [['Discord:', 'link your account for your server role and password recovery.'], ['Video Storage Location:', 'where clips are saved. Change Storage Directory moves it to another folder or drive.'], ['Organize clips', 'sorts older clips into game and session folders, with a preview first. Undo organize puts them back.'], ['Web Player in a separate window:', 'off docks the player inside Peakabu; on opens it in its own window.'], ['Auto-Highlight Detection and Uninstall', 'are at the bottom.']], tip: 'Uninstalling never deletes your saved highlight videos.', imgs: [im('settings-general', 'Settings window on the General tab')] },
    { title: 'Appearance: themes and wallpaper', points: [['Preset', 'changes the whole colour scheme: Peak Dark, Peak Light, Midnight, Ember, Mono, Steel Chrome and more.'], ['Accent', 'swaps just the highlight colour.'], ['Wallpaper:', 'drop in an image, GIF or short video to sit behind the panels.'], ['Readability', 'sliders dim or blur the wallpaper and set how solid the panels are.']], tip: 'Leave “Pause while recording” on. A moving wallpaper competes with your game and the recorder for graphics power.', imgs: [im('appearance', 'Settings Appearance tab with theme preset, wallpaper and readability sliders'), im('appearance-presets', 'Preset menu listing Peak Dark, Peak Light, Midnight, Ember, Mono and Steel Chrome')] },
    { title: 'Test A/V: check your setup before a session', points: [['Sources:', 'pick the microphone and playback device, then Choose video source to preview what will be captured.'], ['Levels:', 'IN is your raw mic, OUT is your mic after noise removal, GAME is game audio.'], ['Test Audio & Video Playback', 'records 8 seconds and plays it back.'], ['Compare', 'switches between Raw and Suppressed during playback, on the exact same moment.']], tip: 'Talk and play game sound during the 8 seconds. If GAME stays flat, check your Windows default output device.', imgs: [im('avtest', 'Test A/V tab with sources, preview and IN, OUT and GAME level meters'), im('avtest-playback', 'Playback section with Raw and Suppressed compare buttons')] },
    { title: 'AI Reel: one edited video from a session’s clips', points: [['Open AI Reel', 'launches its own window. Choose the clips and how long the finished reel should be.'], ['It finds the best moments', 'by looking for the loudest and busiest parts of each clip.'], ['Shared moments go multi-view.', 'When squadmates recorded the same instant, they appear side by side or in a grid of up to four.'], ['Everything runs on your PC.', 'The finished reel is saved in your video storage folder.']], tip: 'This version only uses clips saved on this PC. For clips you don’t have locally, use AI Reel in the web player.', imgs: [im('settings-aireel', 'Settings AI Reel tab with the Open AI Reel button')] }
  ] },
  { name: 'The Temple', pages: [
    { title: 'Watch every point of view in sync', points: [['Open it', 'with “Open in Web Player” on the Squad Session panel. It docks beside the client.'], ['One view plays large,', 'the others as tiles below, all locked to the same moment.'], ['Bottom bar:', 'play, step to the previous or next highlight, and scrub.'], ['Top bar:', 'type any session code and Load. The link icon copies a share link.']], tip: 'Anyone with the share link can watch in a browser, no account needed.', imgs: [im('player', 'Web player docked beside the client with one large view, a tile below, and side panels')] },
    { title: 'Players, Audio and Highlights panels', points: [['Players:', 'open a name to list that player’s highlights. “No clip” means they have no video for that moment.'], ['Audio:', 'each player has a volume slider, Mute, and Solo to hear only them.'], ['Highlights:', 'every saved moment as a numbered button. Click one to load it.'], ['Chapters', 'group highlights by play stretch, each showing its start time, clip count and stars.'], ['Starred only', 'hides everything except favourites.']], tip: 'Each panel has a Collapse link at the top to give the video more room.', imgs: [im('panels-players', 'Players and Audio panels'), im('panels-highlights', 'Highlights panel with chapters and the Starred only filter')] },
    { title: 'Comments pinned to the exact moment', points: [['Leave a comment', 'with the speech-bubble button on a point of view. It is tied to that view and that second.'], ['On playback', 'the comment pops up over the video when its moment arrives.'], ['The bubble with a number', 'opens Session Comments. Click any comment to jump straight to it.'], ['The arrows', 'beside the count in the bottom bar skip to the previous or next comment.']], tip: 'You need to be signed in to comment. Opening the player from Peakabu signs you in automatically.', imgs: [im('comments-overlay', 'A comment shown over the video in the player'), im('comments-list', 'Session Comments list'), im('comments-button', 'Speech-bubble button with a count'), im('comments-nav', 'Comment navigation arrows in the bottom bar')] },
    { title: 'Select clips to download or export', points: [['Select:', 'click the plus on a view. It turns into a tick and the bar appears. All selects every clip.'], ['Download', 'saves the selected clips to your PC as they were recorded.'], ['Combined View', 'makes one video with the selected views side by side, kept in sync.'], ['AI Reel', 'cuts the selection down to its best moments.']], tip: 'The plus buttons only show when you’re signed in. The X at the end of the bar clears your selection.', imgs: [im('export-tile', 'A view tile with a tick and the selection bar underneath'), im('export-bar', 'Selection bar with All, Download, Combined View and AI Reel')] },
    { title: 'AI Reel in the browser: no local files needed', points: [['It works from the uploaded clips,', 'so the videos don’t have to be on your PC. Any squadmate’s clips can go in the reel.'], ['Select clips,', 'press AI Reel, then choose a Length and optionally name the Game.'], ['Style notes', 'steer the edit, such as “keep clutches long, cut fast on kills”. They are saved per game.'], ['Include comments on video', 'burns the session’s comments into the reel. Untick it for a clean cut.']], tip: 'Use this one for squad reels or on a PC that never recorded.', imgs: [im('webreel', 'AI Highlight Reel panel in the web player')] },
    { title: 'Player settings: the gear in the top right', points: [['Show comments over the video:', 'turn off for a clean watch. Only affects you.'], ['Comment size:', 'Small, Medium or Large.'], ['Panels on the left side:', 'moves Highlights and Players/Audio to the left of the video.'], ['Allow comments in this session (host):', 'off hides comment buttons for everyone.'], ['Squad can star highlights (host):', 'off means only the host can star.']], tip: 'The first three choices are saved on this device only. The two host controls apply to the whole session.', imgs: [im('player-settings', 'Player Settings panel with display and host switches')] }
  ] }
    ];

  // ---------------- renderer ----------------
  var COLORS = ['#39d3a0', '#c6f36b', '#a98fe8', '#ffd23f'];
  var KEY = 'pa_guide_v1';
  var flat = [];
  SITES.forEach(function (s, si) { s.pages.forEach(function (pg, pi) { flat.push({ site: si, i: pi, pg: pg }); }); });
  var PAGES = flat.length, TREASURE = PAGES; // index of the treasure stop
  var st = { view: 'trail', cur: 0, seen: { 0: true }, touched: false };
  try { var saved = JSON.parse(localStorage.getItem(KEY) || 'null'); if (saved && saved.seen) st.seen = saved.seen; } catch (e) {}
  function save() { try { localStorage.setItem(KEY, JSON.stringify({ seen: st.seen })); } catch (e) {} }

  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function seenCount() { return Object.keys(st.seen).filter(function (k) { return Number(k) < PAGES; }).length; }
  function titleOf(n) { return n >= PAGES ? 'The treasure' : flat[n].pg.title; }

  function go(n, focus) {
    st.cur = Math.max(0, Math.min(TREASURE, n));
    st.seen[st.cur] = true; save();
    if (st.cur !== TREASURE) st.touched = false;
    st.view = 'trail';
    try { history.replaceState(null, '', st.cur === TREASURE ? '#treasure' : st.cur ? '#page-' + (st.cur + 1) : location.pathname); } catch (e) {}
    render();
    if (focus) { $('gMain').focus({ preventScroll: true }); $('gTrail').scrollIntoView({ block: 'start', behavior: 'smooth' }); }
  }

  function renderNav() {
    var box = $('gStops'); box.replaceChildren();
    var idx = 0;
    SITES.forEach(function (s, si) {
      var grp = el('div', 'stack'); grp.style.gap = '2px';
      var head = el('div', 'g-site'); head.append(el('span', null, 'SITE ' + (si + 1)));
      var nm = el('strong', null, s.name); nm.style.color = COLORS[si]; head.append(nm);
      var line = el('div', 'g-line');
      s.pages.forEach(function (pg) {
        var my = idx++;
        var b = el('button', 'stop' + (st.seen[my] ? ' seen' : '')); b.type = 'button';
        if (my === st.cur) b.setAttribute('aria-current', 'page');
        b.append(el('span', 'dot'), el('span', null, pg.title));
        b.addEventListener('click', function () { go(my, true); });
        line.append(b);
      });
      grp.append(head, line); box.append(grp);
    });
    var t = el('button', 'stop treasure'); t.type = 'button';
    if (st.cur === TREASURE) { t.setAttribute('aria-current', 'page'); t.style.background = '#2a1418'; }
    t.innerHTML = '<svg width="18" height="18" viewBox="0 0 40 40" aria-hidden="true"><path d="M20 3 L34 14 L20 37 L6 14 Z" fill="#e0263f"/><path d="M6 14 H34 M14 14 L20 3 L26 14 L20 37 Z" fill="none" stroke="#ff8a97" stroke-width="1.5"/></svg>';
    t.append(document.createTextNode('The treasure'));
    t.addEventListener('click', function () { go(TREASURE, true); });
    box.append(t);
    var n = seenCount();
    $('gProg').textContent = n + ' / ' + PAGES + ' dug up';
    $('gBar').style.width = Math.round(n / PAGES * 100) + '%';
    var cur = box.querySelector('[aria-current="page"]');
    if (cur) { var top = cur.offsetTop - box.offsetTop; if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - 40) box.scrollTop = top - 80; }
  }

  function renderPage() {
    var main = $('gMain'); main.replaceChildren();
    if (st.cur === TREASURE) { renderTreasure(main); return; }
    var f = flat[st.cur], s = SITES[f.site];
    main.append(el('span', 'g-where', 'Site ' + (f.site + 1) + ' · ' + s.name + ' · page ' + (f.i + 1) + ' of ' + s.pages.length));
    var art = el('article', 'g-page dug');
    art.append(el('h2', null, f.pg.title));
    if (f.pg.imgs.length) {
      var shots = el('div', 'g-shots');
      f.pg.imgs.forEach(function (im, n) {
        var img = el('img'); img.src = im.src; img.alt = im.alt; img.decoding = 'async';
        if (n) img.loading = 'lazy';
        shots.append(img);
      });
      art.append(shots);
    }
    var body = el('div', 'g-body'), ul = el('ul');
    f.pg.points.forEach(function (p) { var li = el('li'); li.append(el('strong', null, p[0]), document.createTextNode(' ' + p[1])); ul.append(li); });
    var tip = el('aside', 'g-tip'); tip.append(el('span', null, 'TRAIL TIP'), el('span', null, f.pg.tip));
    body.append(ul, tip); art.append(body); main.append(art);

    var pager = el('div', 'g-pager');
    var prev = el('button', 'btn btn-ghost', '← ' + (st.cur ? titleOf(st.cur - 1) : 'Start')); prev.type = 'button';
    prev.disabled = st.cur === 0;
    prev.addEventListener('click', function () { go(st.cur - 1, true); });
    var hint = el('span', 'mono', '← → keys work too'); hint.style.cssText = 'font-size:12px;color:#5f7a6a';
    var next = el('button', 'btn btn-glow', 'Dig up: ' + (st.cur + 1 === TREASURE ? 'the treasure' : titleOf(st.cur + 1)) + ' →'); next.type = 'button';
    next.addEventListener('click', function () { go(st.cur + 1, true); });
    pager.append(prev, hint, next); main.append(pager);
  }

  var CHAMBER = '<svg class="chamber" viewBox="0 70 900 410" role="img" style="display:block;width:100%;height:auto"><defs>' +
    '<radialGradient id="tr-glow" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#ff3550" stop-opacity="0.55"/><stop offset="1" stop-color="#ff3550" stop-opacity="0"/></radialGradient>' +
    '<linearGradient id="tr-stone" x1="0" x2="1"><stop offset="0" stop-color="#3a3228"/><stop offset="0.5" stop-color="#5e5648"/><stop offset="1" stop-color="#3a3228"/></linearGradient>' +
    '<radialGradient id="tr-flash" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#ffffff" stop-opacity="1"/><stop offset="0.4" stop-color="#ffd6dc" stop-opacity="0.7"/><stop offset="1" stop-color="#ff3550" stop-opacity="0"/></radialGradient></defs>' +
    '<path d="M0 452 H900 V480 H0 Z" fill="#14100b"/><path d="M0 452 H900" stroke="#2e261c" stroke-width="3"/>' +
    '<g transform="translate(120 0)"><ellipse class="gemaura" cx="330" cy="262" rx="190" ry="150" fill="url(#tr-glow)"/>' +
    '<rect x="232" y="430" width="196" height="24" rx="6" fill="#4a4034" stroke="#241c12" stroke-width="3"/>' +
    '<rect x="272" y="350" width="116" height="82" fill="url(#tr-stone)" stroke="#241c12" stroke-width="3"/>' +
    '<path d="M290 362 V420 M330 362 V420 M370 362 V420" stroke="#2c241a" stroke-width="3" opacity="0.6"/>' +
    '<rect x="246" y="330" width="168" height="22" rx="6" fill="#4a4034" stroke="#241c12" stroke-width="3"/>' +
    '<g class="gem"><path d="M330 214 L382 252 L330 332 L278 252 Z" fill="#c4122c" stroke="#5a0614" stroke-width="3" stroke-linejoin="round"/>' +
    '<path d="M278 252 L330 214 L382 252 Z" fill="#ff4d63"/><path d="M304 252 L330 214 L356 252 Z" fill="#ff8a97"/>' +
    '<path d="M278 252 L330 332 L304 252 Z" fill="#a50e24"/><path d="M382 252 L330 332 L356 252 Z" fill="#e0263f"/>' +
    '<path d="M304 252 L330 332 L356 252 Z" fill="#d61a34"/><path d="M278 252 H382" stroke="#ffb3bc" stroke-width="2" opacity="0.7"/>' +
    '<path d="M318 228 L326 222" stroke="#ffffff" stroke-width="4" stroke-linecap="round" opacity="0.85"/></g>' +
    '<g class="flash"><circle cx="330" cy="268" r="60" fill="url(#tr-flash)"/><path d="M330 214 L335 262 L384 268 L335 274 L330 322 L325 274 L276 268 L325 262 Z" fill="#ffffff"/></g></g></svg>';

  function renderTreasure(main) {
    var where = el('span', 'g-where', 'The end of the trail'); where.style.color = '#ff8a97';
    var box = el('section', 'chamber-box' + (st.touched ? ' rumble' : '')); box.setAttribute('aria-label', 'Treasure chamber');
    if (st.touched) [[22, .2, 10], [41, .45, 7], [63, .3, 10], [78, .6, 13], [33, .75, 6]].forEach(function (p) {
      var pb = el('span', 'pebble'); pb.style.left = p[0] + '%'; pb.style.animationDelay = p[1] + 's'; pb.style.width = pb.style.height = p[2] + 'px'; box.append(pb);
    });
    box.append(el('div', 'plaque', st.touched ? 'TOLD YOU.' : 'DO NOT TOUCH'));
    var wrap = el('div'); wrap.style.cssText = 'position:relative;width:100%';
    wrap.innerHTML = CHAMBER;
    var svg = wrap.firstChild;
    if (st.touched) svg.classList.add('touched');
    svg.setAttribute('aria-label', st.touched ? 'The ruby flares and the chamber shakes' : 'A glowing ruby on a stone pedestal');
    var ruby = el('button', 'ruby'); ruby.type = 'button'; ruby.setAttribute('aria-label', 'Touch the ruby');
    ruby.addEventListener('click', function () {
      if (st.touched) { svg.classList.remove('touched'); void svg.getBBox(); svg.classList.add('touched'); return; }
      st.touched = true; renderPage();
      var r = document.querySelector('.ruby'); if (r) r.focus({ preventScroll: true });
    });
    wrap.append(ruby);
    box.append(wrap, el('p', 't-line', st.touched ? '…you touched it, didn’t you.' : 'The trail ends here. Just look, don’t touch.'));
    main.append(where, box);
    if (!st.touched) return;

    var rev = el('div', 'reveal');
    var q = el('div', 'qref');
    var h = el('h2', null, 'A night of Peakabu in three stages'); h.style.fontSize = '26px';
    var cols = el('div', 'cols');
    [['BEFORE THE MATCH', '#39d3a0', ['Host creates a session and shares the invite link.', 'Everyone joins and presses Start Highlight Session.', 'Wait for Ready, and check each name shows REC.']],
     ['DURING PLAY', '#c6f36b', ['Press the save hotkey right after a good fight.', 'Use the star hotkey for the ones worth rewatching.', 'Or let Auto-Highlight catch the loud moments.']],
     ['AFTERWARDS', '#ffd23f', ['Let the Upload Queue empty before closing.', 'Open the web player and rewatch together.', 'Comment, star, and share the link.']]].forEach(function (c) {
      var d = el('div'), s = el('strong', null, c[0]); s.style.color = c[1]; d.append(s);
      c[2].forEach(function (t) { d.append(el('span', null, t)); }); cols.append(d);
    });
    var pr = el('button', 'btn btn-glow', 'Print the card'); pr.type = 'button'; pr.style.alignSelf = 'flex-start';
    pr.addEventListener('click', function () { document.body.classList.add('print-card'); window.print(); });
    q.append(h, cols, pr);
    var n = seenCount();
    var b = el('div', 'badge');
    b.innerHTML = '<svg width="72" height="72" viewBox="0 0 72 72" aria-hidden="true"><circle cx="36" cy="36" r="33" fill="#13281b" stroke="#c6f36b" stroke-width="3"/><path d="M36 16 L50 26 L36 56 L22 26 Z" fill="#e0263f"/><path d="M22 26 H50" stroke="#ff8a97" stroke-width="2"/></svg>';
    var bs = el('strong', null, 'Full expedition'); bs.style.cssText = 'font:700 22px var(--display);color:var(--head)';
    var bt = el('span', null, n >= PAGES ? 'Every page dug up. You know Peakabu inside out.' : n + ' of ' + PAGES + ' pages dug up. A few stops are still buried.');
    bt.style.cssText = 'font-size:14px;color:var(--muted)';
    var back = el('button', 'btn btn-ghost', 'Back to Base Camp'); back.type = 'button';
    back.addEventListener('click', function () { go(0, true); });
    b.append(bs, bt, back);
    rev.append(q, b); main.append(rev);
  }
  window.addEventListener('afterprint', function () { document.body.classList.remove('print-card'); });

  function renderList() {
    var q = $('gq').value.trim().toLowerCase();
    var grid = $('gListGrid'); grid.replaceChildren();
    var idx = 0;
    SITES.forEach(function (s, si) {
      var sec = el('section'), head = el('div', 'g-site');
      head.append(el('span', null, 'SITE ' + (si + 1)));
      var nm = el('h2', null, s.name); nm.style.cssText = 'font-size:20px;color:' + COLORS[si]; head.append(nm);
      sec.append(head);
      var any = false;
      s.pages.forEach(function (pg, pi) {
        var my = idx++;
        var hay = (pg.title + ' ' + pg.points.map(function (p) { return p.join(' '); }).join(' ') + ' ' + pg.tip).toLowerCase();
        if (q && hay.indexOf(q) < 0) return;
        any = true;
        var b = el('button', 'idx' + (st.seen[my] ? ' seen' : '')); b.type = 'button';
        b.append(el('span', null, String(pi + 1)), el('span', null, pg.title), el('span', 'd', '●'));
        b.addEventListener('click', function () { go(my, true); });
        sec.append(b);
      });
      if (!any) { var e = el('span', null, 'No matches here'); e.style.cssText = 'padding:6px 10px;font-size:14px;color:#5f7a6a'; sec.append(e); }
      grid.append(sec);
    });
  }

  function render() {
    var list = st.view === 'list';
    $('vTrail').setAttribute('aria-pressed', list ? 'false' : 'true');
    $('vList').setAttribute('aria-pressed', list ? 'true' : 'false');
    $('gHint').textContent = list ? 'Every page at a glance. Search or jump straight to one.' : 'Follow the trail page by page, or jump to any stop.';
    $('gList').hidden = !list; $('gTrail').hidden = list;
    if (list) renderList(); else { renderNav(); renderPage(); }
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('vTrail').addEventListener('click', function () { st.view = 'trail'; render(); });
    $('vList').addEventListener('click', function () { st.view = 'list'; render(); $('gq').focus(); });
    $('gq').addEventListener('input', renderList);
    document.addEventListener('keydown', function (e) {
      if (st.view !== 'trail' || e.altKey || e.ctrlKey || e.metaKey) return;
      var t = e.target && e.target.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return;
      if (e.key === 'ArrowRight' && st.cur < TREASURE) go(st.cur + 1);
      else if (e.key === 'ArrowLeft' && st.cur > 0) go(st.cur - 1);
    });
    function fromHash() {
      var m = /^#page-(\d+)$/.exec(location.hash);
      if (m) return Math.max(0, Math.min(TREASURE, Number(m[1]) - 1));
      return location.hash === '#treasure' ? TREASURE : null;
    }
    window.addEventListener('hashchange', function () { var n = fromHash(); if (n !== null && n !== st.cur) go(n); });
    var h = fromHash();
    if (h !== null) st.cur = h;
    st.seen[st.cur] = true; save();
    render();
  });
})();
