const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const { exiftool } = require('exiftool-vendored');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 500 * 1024 * 1024 }
});

app.use(express.static(path.join(__dirname, 'public')));

const IPHONE_PROFILES = {
  'iPhone 12 Pro Max': { model: 'iPhone 12 Pro Max', software: '16.7.2' },
  'iPhone 14 Pro':     { model: 'iPhone 14 Pro',     software: '17.4.1' },
  'iPhone 15 Pro':     { model: 'iPhone 15 Pro',     software: '17.4.1' }
};

function runCmd(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 300000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

function cleanup(...files) {
  for (const f of files) {
    try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  }
}

app.post('/process', upload.single('video'), async (req, res) => {
  const inputPath = req.file?.path;
  if (!inputPath) return res.status(400).json({ error: 'No video uploaded.' });

  const { model, lat, lon, alt, filename, date } = req.body;
  const profile = IPHONE_PROFILES[model];
  if (!profile) {
    cleanup(inputPath);
    return res.status(400).json({ error: 'Invalid iPhone model.' });
  }

  const tmpDir = os.tmpdir();
  const cleanPath = path.join(tmpDir, `clean_${Date.now()}.mp4`);
  const finalPath = path.join(tmpDir, `final_${Date.now()}.mp4`);
  const outputName = (filename || 'output').replace(/[^a-zA-Z0-9_\-]/g, '_') + '.mp4';

  try {
    // Step 1: Strip all metadata with FFmpeg
    await runCmd(
      `ffmpeg -y -i "${inputPath}" -map_metadata -1 -map_metadata:s:v -1 -map_metadata:s:a -1 -c copy "${cleanPath}"`
    );

    // Step 2: Write Apple QuickTime keys with exiftool-vendored
    const creationDate = date
      ? new Date(date.replace(' ', 'T')).toISOString()
      : new Date().toISOString();

    const tags = {
      'Keys:Make': 'Apple',
      'Keys:Model': profile.model,
      'Keys:Software': profile.software,
      'Keys:CreationDate': creationDate,
      CreateDate: creationDate,
      ModifyDate: creationDate,
      TrackCreateDate: creationDate,
      TrackModifyDate: creationDate,
      MediaCreateDate: creationDate,
      MediaModifyDate: creationDate,
    };

    if (lat && lon) {
      const a = parseFloat(alt) || 10;
      const latN = parseFloat(lat);
      const lonN = parseFloat(lon);
      const latStr = latN >= 0 ? `+${latN.toFixed(4)}` : `${latN.toFixed(4)}`;
      const lonStr = lonN >= 0 ? `+${lonN.toFixed(4)}` : `${lonN.toFixed(4)}`;
      tags['Keys:GPSCoordinates'] = `${latStr}${lonStr}+${a.toFixed(3)}/`;
    }

    await exiftool.write(cleanPath, tags, ['-overwrite_original']);

    // Step 3: Rewrite container with FFmpeg (clean brand + no encoder signature)
    await runCmd(
      `ffmpeg -y -i "${cleanPath}" -c copy \
        -movflags use_metadata_tags \
        -fflags +bitexact \
        -map_metadata 0 \
        -metadata make="Apple" \
        -metadata model="${profile.model}" \
        -metadata software="${profile.software}" \
        -metadata creation_time="${creationDate}" \
        -metadata encoder="" \
        -brand qt \
        "${finalPath}"`
    );

    res.setHeader('Content-Disposition', `attachment; filename="${outputName}"`);
    res.setHeader('Content-Type', 'video/mp4');
    const stream = fs.createReadStream(finalPath);
    stream.pipe(res);
    stream.on('end', () => cleanup(inputPath, cleanPath, finalPath));
    stream.on('error', () => cleanup(inputPath, cleanPath, finalPath));

  } catch (err) {
    cleanup(inputPath, cleanPath, finalPath);
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

process.on('exit', () => exiftool.end());
app.listen(PORT, () => console.log(`iPhone Meta Tagger running on port ${PORT}`));
