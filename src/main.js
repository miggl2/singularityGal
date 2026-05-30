import './style.css';
import Matter from 'matter-js';
import decomp from 'poly-decomp';

const {
  Body,
  Bodies,
  Common,
  Engine,
  Sleeping,
  Vertices,
  World,
} = Matter;

Common.setDecomp(decomp);

const VIEW_W = 1280;
const VIEW_H = 720;
const PLATFORM_W = 520;
const PLATFORM_H = 42;
const PLATFORM_Y = 648;
const PLATFORM_TOP = PLATFORM_Y - PLATFORM_H / 2;
const DROP_OFFSET = 190;
const ROTATE_STEP = Math.PI / 12;
const FIXED_DT = 1000 / 60;
const DEBUG = new URLSearchParams(window.location.search).has('debug');
const BASE_URL = import.meta.env.BASE_URL;

const state = {
  blocks: [],
  images: new Map(),
  engine: null,
  platform: null,
  pieces: [],
  current: null,
  currentAngle: 0,
  pointerX: 0,
  dropCount: 0,
  bestHeight: 0,
  stableTop: PLATFORM_TOP,
  viewTop: 0,
  targetViewTop: 0,
  lastDrop: null,
  accumulator: 0,
  lastFrame: performance.now(),
  gameOver: false,
  bag: [],
};

document.querySelector('#app').innerHTML = `
  <main class="game-shell" aria-label="AI block stacking game">
    <canvas id="game-canvas" aria-label="game canvas"></canvas>
    <div class="hud" aria-live="polite">
      <div class="stat"><span>블럭</span><strong id="blocks-value">0</strong></div>
      <div class="stat"><span>최고</span><strong id="height-value">0</strong></div>
    </div>
    <div class="next-chip" id="next-chip"></div>
    <div class="message" id="message"></div>
  </main>
`;

const shell = document.querySelector('.game-shell');
const canvas = document.querySelector('#game-canvas');
const ctx = canvas.getContext('2d');
const blocksValue = document.querySelector('#blocks-value');
const heightValue = document.querySelector('#height-value');
const nextChip = document.querySelector('#next-chip');
const message = document.querySelector('#message');

function resizeCanvas() {
  const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  canvas.width = Math.round(VIEW_W * dpr);
  canvas.height = Math.round(VIEW_H * dpr);
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

async function loadGameAssets() {
  const response = await fetch(assetUrl('assets/blocks.json'));
  state.blocks = await response.json();

  await Promise.all(
    state.blocks.map(
      (block) =>
        new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => {
            state.images.set(block.id, image);
            resolve();
          };
          image.onerror = reject;
          image.src = assetUrl(block.src);
        }),
    ),
  );
}

function assetUrl(path) {
  const normalized = path.replace(/^\/+/, '');
  return new URL(normalized, window.location.origin + BASE_URL).toString();
}

function makeEngine() {
  const engine = Engine.create({
    enableSleeping: true,
    gravity: { x: 0, y: 0.95, scale: 0.001 },
  });
  engine.positionIterations = 14;
  engine.velocityIterations = 12;
  engine.constraintIterations = 4;

  const platform = Bodies.rectangle(0, PLATFORM_Y, PLATFORM_W, PLATFORM_H, {
    isStatic: true,
    label: 'platform',
    friction: 1.25,
    frictionStatic: 2.6,
    restitution: 0,
    slop: 0.02,
  });
  World.add(engine.world, platform);

  state.engine = engine;
  state.platform = platform;
}

function resetGame() {
  makeEngine();
  state.pieces = [];
  state.current = null;
  state.currentAngle = 0;
  state.pointerX = 0;
  state.dropCount = 0;
  state.bestHeight = 0;
  state.stableTop = PLATFORM_TOP;
  state.viewTop = 0;
  state.targetViewTop = 0;
  state.lastDrop = null;
  state.accumulator = 0;
  state.gameOver = false;
  state.bag = [];
  message.textContent = '';
  message.classList.remove('show');
  spawnPreview();
  updateHud();
}

function nextAsset() {
  if (state.bag.length === 0) {
    state.bag = [...state.blocks].sort(() => Math.random() - 0.5);
  }
  return state.bag.pop();
}

function spawnPreview() {
  if (state.gameOver) return;
  state.current = nextAsset();
  state.currentAngle = (Math.random() - 0.5) * 0.12;
  nextChip.textContent = state.current?.name ?? '';
}

function assetScale(asset) {
  return asset.displayHeight / asset.height;
}

function makeBody(asset, x, y, angle) {
  const scale = assetScale(asset);
  const vertices = asset.vertices.map((point) => ({
    x: (point.x - asset.width / 2) * scale,
    y: (point.y - asset.height / 2) * scale,
  }));

  const sorted = Vertices.clockwiseSort(vertices);
  const body = Bodies.fromVertices(
    x,
    y,
    [sorted],
    {
      label: asset.id,
      friction: asset.type === 'logo' ? 0.92 : 1.05,
      frictionStatic: asset.type === 'logo' ? 1.75 : 2.2,
      frictionAir: 0.022,
      restitution: 0.006,
      density: asset.type === 'logo' ? 0.00115 : 0.00135,
      slop: 0.055,
      sleepThreshold: 42,
    },
    true,
    0.01,
    8,
    0.01,
  );

  Body.setAngle(body, angle);
  return body;
}

function dropCurrent() {
  if (!state.current || state.gameOver || state.lastDrop) return;

  const asset = state.current;
  const y = previewY();
  const x = clamp(state.pointerX, -VIEW_W / 2 + 90, VIEW_W / 2 - 90);
  const body = makeBody(asset, x, y, state.currentAngle);
  const piece = {
    asset,
    body,
    scale: assetScale(asset),
    stable: false,
    quietFor: 0,
    age: 0,
  };

  state.pieces.push(piece);
  state.lastDrop = piece;
  state.current = null;
  state.dropCount += 1;
  World.add(state.engine.world, body);
  updateHud();
}

function rotatePreview(direction = 1) {
  if (!state.current || state.gameOver) return;
  state.currentAngle += direction * ROTATE_STEP;
}

function previewY() {
  return state.stableTop - DROP_OFFSET;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function screenToWorldX(clientX) {
  const rect = shell.getBoundingClientRect();
  const normalizedX = (clientX - rect.left) / rect.width;
  return normalizedX * VIEW_W - VIEW_W / 2;
}

function updatePointer(event) {
  state.pointerX = screenToWorldX(event.clientX);
}

function markGameOver() {
  if (state.gameOver) return;
  state.gameOver = true;
  state.current = null;
  nextChip.textContent = '';
  message.innerHTML = `<strong>GAME OVER</strong><span>최고 ${Math.round(state.bestHeight)} · 클릭 또는 Enter</span>`;
  message.classList.add('show');
}

function updateHud() {
  blocksValue.textContent = String(state.dropCount);
  heightValue.textContent = String(Math.round(state.bestHeight));
}

function recomputeStableTop() {
  let top = PLATFORM_TOP;
  for (const piece of state.pieces) {
    if (piece.stable) {
      top = Math.min(top, piece.body.bounds.min.y);
    }
  }

  state.stableTop = top;
  const height = Math.max(0, PLATFORM_TOP - state.stableTop);
  if (height > state.bestHeight) {
    state.bestHeight = height;
    updateHud();
  }

  const wantedTop = Math.min(0, state.stableTop - 260);
  state.targetViewTop = Math.min(state.targetViewTop, wantedTop);
}

function updatePieces(dtSeconds) {
  for (const piece of state.pieces) {
    const body = piece.body;
    piece.age += dtSeconds;

    if (body.position.y > PLATFORM_Y + 260 || Math.abs(body.position.x) > VIEW_W * 0.78) {
      markGameOver();
    }

    const speed = Math.hypot(body.velocity.x, body.velocity.y);
    const spin = Math.abs(body.angularVelocity);

    if (piece.stable && !body.isSleeping && (speed > 0.18 || spin > 0.09)) {
      piece.stable = false;
      piece.quietFor = 0;
      recomputeStableTop();
    }

    if (!piece.stable) {
      if (body.isSleeping || (piece.age > 0.55 && speed < 0.09 && spin < 0.045)) {
        piece.quietFor += dtSeconds;
      } else {
        piece.quietFor = 0;
      }

      if (body.isSleeping || piece.quietFor > 0.78) {
        piece.stable = true;
        Body.setVelocity(body, { x: 0, y: 0 });
        Body.setAngularVelocity(body, 0);
        Sleeping.set(body, true);
        recomputeStableTop();
        if (state.lastDrop === piece) {
          state.lastDrop = null;
          spawnPreview();
        }
      }
    }
  }
}

function updatePhysics(now) {
  const frame = Math.min(80, now - state.lastFrame);
  state.lastFrame = now;
  state.accumulator += frame;

  let steps = 0;
  while (state.accumulator >= FIXED_DT && steps < 5) {
    Engine.update(state.engine, FIXED_DT);
    updatePieces(FIXED_DT / 1000);
    state.accumulator -= FIXED_DT;
    steps += 1;
  }

  if (steps === 5) {
    state.accumulator = 0;
  }

  state.viewTop += (state.targetViewTop - state.viewTop) * 0.032;
}

function worldToScreen(position) {
  return {
    x: VIEW_W / 2 + position.x,
    y: position.y - state.viewTop,
  };
}

function drawImageAt(asset, bodyLike, alpha = 1) {
  const image = state.images.get(asset.id);
  if (!image) return;

  const scale = assetScale(asset);
  const screen = worldToScreen(bodyLike.position);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(screen.x, screen.y);
  ctx.rotate(bodyLike.angle);
  ctx.drawImage(image, (-asset.width * scale) / 2, (-asset.height * scale) / 2, asset.width * scale, asset.height * scale);
  ctx.restore();
}

function drawBodyDebug(body) {
  if (!DEBUG) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(0, 128, 160, 0.55)';
  ctx.lineWidth = 1.5;
  for (const part of body.parts.slice(1)) {
    ctx.beginPath();
    part.vertices.forEach((vertex, index) => {
      const screen = worldToScreen(vertex);
      if (index === 0) ctx.moveTo(screen.x, screen.y);
      else ctx.lineTo(screen.x, screen.y);
    });
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}

function drawPlatform() {
  const left = VIEW_W / 2 - PLATFORM_W / 2;
  const top = PLATFORM_Y - state.viewTop - PLATFORM_H / 2;
  ctx.save();
  ctx.fillStyle = '#151515';
  ctx.fillRect(left, top, PLATFORM_W, PLATFORM_H);
  ctx.fillStyle = '#2f2f2f';
  ctx.fillRect(left, top, PLATFORM_W, 7);
  ctx.fillStyle = '#d9483b';
  ctx.fillRect(left - 10, top + 4, 10, PLATFORM_H - 8);
  ctx.fillRect(left + PLATFORM_W, top + 4, 10, PLATFORM_H - 8);
  ctx.restore();
}

function drawHeightLine() {
  if (state.bestHeight <= 0) return;
  const y = state.stableTop - state.viewTop;
  ctx.save();
  ctx.strokeStyle = 'rgba(44, 120, 92, 0.24)';
  ctx.setLineDash([8, 12]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(110, y);
  ctx.lineTo(VIEW_W - 110, y);
  ctx.stroke();
  ctx.restore();
}

function drawPreview() {
  if (!state.current || state.gameOver) return;
  const preview = {
    position: {
      x: clamp(state.pointerX, -VIEW_W / 2 + 90, VIEW_W / 2 - 90),
      y: previewY(),
    },
    angle: state.currentAngle,
  };

  ctx.save();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)';
  ctx.setLineDash([5, 9]);
  ctx.lineWidth = 1.5;
  const x = VIEW_W / 2 + preview.position.x;
  ctx.beginPath();
  ctx.moveTo(x, preview.position.y - state.viewTop + 75);
  ctx.lineTo(x, PLATFORM_TOP - state.viewTop);
  ctx.stroke();
  ctx.restore();

  drawImageAt(state.current, preview, 0.48);
}

function render() {
  ctx.clearRect(0, 0, VIEW_W, VIEW_H);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);

  drawHeightLine();
  drawPlatform();

  for (const piece of state.pieces) {
    drawImageAt(piece.asset, piece.body, piece.stable ? 1 : 0.96);
    drawBodyDebug(piece.body);
  }

  drawPreview();
}

function loop(now) {
  if (state.engine) {
    updatePhysics(now);
    render();
  }
  requestAnimationFrame(loop);
}

shell.addEventListener('pointermove', updatePointer);
shell.addEventListener('pointerdown', (event) => {
  updatePointer(event);
  if (event.button === 2) {
    event.preventDefault();
    rotatePreview(1);
    return;
  }
  if (state.gameOver) {
    resetGame();
    return;
  }
  dropCurrent();
});

shell.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  rotatePreview(1);
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'a' || event.key === 'A' || event.key === 'ArrowLeft') {
    rotatePreview(-1);
  }
  if (event.key === 'd' || event.key === 'D' || event.key === 'ArrowRight') {
    rotatePreview(1);
  }
  if (state.gameOver && event.key === 'Enter') {
    resetGame();
  }
});

window.addEventListener('resize', resizeCanvas);

resizeCanvas();
loadGameAssets()
  .then(() => {
    resetGame();
    requestAnimationFrame(loop);
  })
  .catch((error) => {
    console.error(error);
    message.innerHTML = '<strong>ASSET ERROR</strong><span>로컬 에셋을 불러오지 못했습니다.</span>';
    message.classList.add('show');
  });
