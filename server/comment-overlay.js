// ================================
// COMMENT-OVERLAY — generates ASS subtitle files from comments data
// for use by composite.js and aireel.js FFmpeg pipelines.
//
// ASS (Advanced SubStation Alpha) is used instead of chaining drawtext
// filters because it handles timed positioned text natively, scales to
// hundreds of comments without FFmpeg filter-chain length issues, and
// avoids the multi-layer escaping nightmare of drawtext.
//
// Requires libass in FFmpeg (standard on Ubuntu's ffmpeg package).
// ================================
const fs = require('fs');
const { spawn } = require('child_process');

const PA_DISPLAY_SEC = 4.5;

// --- One-time capability check ---
let assAvailable = null;

function checkAssFilter() {
  if (assAvailable !== null) return Promise.resolve(assAvailable);
  return new Promise(resolve => {
    const p = spawn('ffmpeg', ['-filters']);
    let out = '';
    p.stderr.on('data', d => { out += d; });
    p.stdout.on('data', d => { out += d; });
    p.on('close', () => { assAvailable = out.includes(' ass '); resolve(assAvailable); });
    p.on('error', () => { assAvailable = false; resolve(false); });
  });
}

// --- ASS generation ---
// tileMap: { [uploadId]: { x, y, w, h, offsetSec } }
//   x,y = pixel origin of this clip's tile on the output canvas
//   w,h = pixel size of the tile
//   offsetSec = seconds offset of this clip in the output timeline
// canvasW, canvasH = output video dimensions
// displaySec = how long each comment stays visible (default 4.5s)
function generateASS(comments, tileMap, canvasW, canvasH, displaySec) {
  displaySec = displaySec || PA_DISPLAY_SEC;
  var fontSize = Math.max(10, Math.round(canvasH / 55));

  // Colors in ASS &HAABBGGRR& format
  var GREEN = '&H00A0D339&';   // #39d3a0
  var TEXT = '&H00ECF5E8&';    // #e8f5ec
  var BG = '&HAA11160A&';      // #0a1611 semi-transparent

  var ass = '';
  ass += '[Script Info]\n';
  ass += 'ScriptType: v4.00+\n';
  ass += 'PlayResX: ' + canvasW + '\n';
  ass += 'PlayResY: ' + canvasH + '\n';
  ass += 'WrapStyle: 0\n\n';

  ass += '[V4+ Styles]\n';
  ass += 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n';
  ass += 'Style: PeakAbu,DejaVu Sans,' + fontSize + ',' + TEXT + ',&H000000FF,&H80000A11,' + BG + ',0,0,0,0,100,100,0,0,3,1,0,7,10,10,10,1\n\n';

  ass += '[Events]\n';
  ass += 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';

  var count = 0;
  for (var i = 0; i < comments.length; i++) {
    var c = comments[i];
    var tile = tileMap[c.uploadId];
    if (!tile) continue;

    var startSec = (tile.offsetSec || 0) + c.timestampMs / 1000;
    if (startSec < 0) continue;
    var endSec = startSec + displaySec;

    var px, py;
    if (c.positionX != null && c.positionY != null) {
      px = Math.round(tile.x + (c.positionX / 100) * tile.w);
      py = Math.round(tile.y + (c.positionY / 100) * tile.h);
    } else {
      px = Math.round(tile.x + tile.w * 0.04);
      py = Math.round(tile.y + tile.h * 0.38);
    }

    px = Math.max(5, Math.min(canvasW - 50, px));
    py = Math.max(5, Math.min(canvasH - 20, py));

    var username = escapeASS(c.username);
    var text = escapeASS(c.text);

    ass += 'Dialogue: 0,' + fmtTime(startSec) + ',' + fmtTime(endSec) +
      ',PeakAbu,,0,0,0,,{\\pos(' + px + ',' + py + ')\\c' + GREEN + '}' +
      username + '{\\c' + TEXT + '}: ' + text + '\n';

    count++;
    if (count >= 60) break; // cap per export to keep FFmpeg happy
  }

  return { ass: ass, count: count };
}

function escapeASS(s) {
  return (s || '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\N')
    .replace(/\{/g, '')
    .replace(/\}/g, '');
}

function fmtTime(sec) {
  sec = Math.max(0, sec);
  var h = Math.floor(sec / 3600);
  var m = Math.floor((sec % 3600) / 60);
  var s = Math.floor(sec % 60);
  var cs = Math.min(99, Math.round((sec % 1) * 100));
  return h + ':' + String(m).padStart(2, '0') + ':' +
    String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
}

// Escape a file path for use inside an FFmpeg filter string
function escapeFilterPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

module.exports = { generateASS, checkAssFilter, escapeFilterPath };