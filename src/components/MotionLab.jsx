import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  Activity,
  AlertTriangle,
  Compass,
  Gauge,
  Link,
  Minus,
  Play,
  RadioTower,
  RefreshCw,
  Smartphone,
  Square,
  Wifi,
  X,
} from 'lucide-react';
import { createQrPath } from '../utils/qrCode';

const publishEndpoint = '/api/motion/publish';
const socketEndpoint = '/api/motion/socket';
const configEndpoint = '/api/motion/config';
const hostedRelayUrl = 'https://motion-lab-relay.onrender.com';
const configuredRelayUrl = import.meta.env.VITE_MOTION_RELAY_URL || '';
const targetPublishIntervalMs = 1000 / 45;
const maxSocketBufferedBytes = 256_000;
const orientationReconnectGapMs = 1800;
const swordRestGyroThreshold = 18;
const swordFastGyroThreshold = 220;
const swordRestOrientationDeadband = THREE.MathUtils.degToRad(0.75);
const swordFastOrientationDeadband = THREE.MathUtils.degToRad(0.12);
const swordRestOrientationResponse = 9;
const swordFastOrientationResponse = 30;
const swordAccelerationDeadband = 0.18;
const swordRestPositionResponse = 7;
const swordFastPositionResponse = 18;

const dampAlpha = (response, delta) => 1 - Math.exp(-response * delta);
const deadbandValue = (value, threshold) => {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const magnitude = Math.abs(value);
  if (magnitude <= threshold) {
    return 0;
  }

  return Math.sign(value) * (magnitude - threshold);
};

const createApiUrl = (origin, endpoint) => new URL(endpoint, origin).toString();

const createSocketUrl = (origin, endpoint) => {
  const url = new URL(endpoint, origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
};

const normalizeOrigin = (value) => {
  if (!value) {
    return '';
  }

  try {
    return new URL(value, window.location.origin).origin;
  } catch {
    return '';
  }
};

const isLocalNetworkOrigin = (origin = window.location.origin) => {
  try {
    const { hostname } = new URL(origin, window.location.origin);

    return (
      hostname === 'localhost'
      || hostname === '127.0.0.1'
      || hostname === '[::1]'
      || hostname.endsWith('.local')
      || /^10\./.test(hostname)
      || /^192\.168\./.test(hostname)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    );
  } catch {
    return false;
  }
};

const getDefaultRelayOrigin = () => (
  normalizeOrigin(configuredRelayUrl)
  || (isLocalNetworkOrigin() ? window.location.origin : hostedRelayUrl)
);

const createSessionId = () => {
  if (window.crypto?.getRandomValues) {
    const values = new Uint8Array(6);
    window.crypto.getRandomValues(values);
    return Array.from(values, value => value.toString(16).padStart(2, '0')).join('');
  }

  return Math.random().toString(36).slice(2, 14);
};

const toFiniteNumber = (value) => (
  Number.isFinite(value) ? Number(value) : null
);

const readVector = (vector) => ({
  x: toFiniteNumber(vector?.x),
  y: toFiniteNumber(vector?.y),
  z: toFiniteNumber(vector?.z),
});

const readRotationRate = (rotationRate) => ({
  alpha: toFiniteNumber(rotationRate?.alpha),
  beta: toFiniteNumber(rotationRate?.beta),
  gamma: toFiniteNumber(rotationRate?.gamma),
});

const getScreenAngle = () => {
  const screenAngle = window.screen?.orientation?.angle;
  const legacyAngle = window.orientation;
  return toFiniteNumber(screenAngle ?? legacyAngle) || 0;
};

const getSearchParams = () => new URLSearchParams(window.location.search);

const getHashParams = () => {
  const hash = window.location.hash.replace(/^#/, '');
  const queryStart = hash.indexOf('?');

  return new URLSearchParams(queryStart >= 0 ? hash.slice(queryStart + 1) : '');
};

const getRelayOrigin = () => {
  const relayParam = getSearchParams().get('relay') || getHashParams().get('relay');
  const relayOrigin = normalizeOrigin(relayParam) || getDefaultRelayOrigin();

  return relayOrigin || window.location.origin;
};

const getPhoneSessionId = () => {
  const pathSession = window.location.pathname.match(/^\/motion-phone\/([^/]+)\/?$/)?.[1];
  const hashSession = window.location.hash.match(/^#\/motion-phone\/([^?/#]+)\/?/)?.[1];
  const params = getSearchParams();
  const hashParams = getHashParams();

  return (
    (pathSession ? decodeURIComponent(pathSession) : '')
    || (hashSession ? decodeURIComponent(hashSession) : '')
    || params.get('s')
    || params.get('session')
    || hashParams.get('s')
    || hashParams.get('session')
    || ''
  );
};

const createPhoneUrl = (origin, sessionId, relayOrigin) => {
  const phoneUrl = new URL('/', origin);
  const hashParams = new URLSearchParams();

  if (
    normalizeOrigin(relayOrigin)
    && normalizeOrigin(relayOrigin) !== normalizeOrigin(origin)
  ) {
    hashParams.set('relay', normalizeOrigin(relayOrigin));
  }
  const hashQuery = hashParams.toString();
  phoneUrl.hash = `/motion-phone/${encodeURIComponent(sessionId)}${hashQuery ? `?${hashQuery}` : ''}`;
  return phoneUrl.toString();
};

const formatMetric = (value, digits = 1) => (
  Number.isFinite(value) ? value.toFixed(digits) : '--'
);

const formatVector = (vector, digits = 2) => (
  `${formatMetric(vector?.x, digits)}, ${formatMetric(vector?.y, digits)}, ${formatMetric(vector?.z, digits)}`
);

const getPacketOrientation = (packet) => packet?.orientation || {};
const getPacketMotion = (packet) => packet?.motion || {};

const hasUsableOrientationPacket = (packet) => {
  const orientation = getPacketOrientation(packet);

  return (
    Number.isFinite(orientation.alpha)
    && Number.isFinite(orientation.beta)
    && Number.isFinite(orientation.gamma)
  );
};

const getPacketTimestamp = (packet) => {
  const timestamp = packet?.relayReceivedAt ?? packet?.sentAt;
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const swordRestPosition = new THREE.Vector3(0, -0.92, 0);
const blockTravelDuration = 3.2;
const blockFirstSpawnDelayMs = 900;
const blockSpawnStartIntervalMs = 1450;
const blockSpawnMinIntervalMs = 680;
const blockSpawnRampDurationMs = 90_000;
const maxActiveBlocks = 7;
const slashTrailMinSpeed = 4.2;
const slashTrailVisibleMinIntensity = 0.14;
const slashCutMinSpeed = 2.85;
const blockCutRadius = 0.47;
const blockCoreSize = 0.62;
const swordFloorY = -1.36;

const blockLaneConfigs = [
  { id: 'right', color: 0xff2d55, hit: new THREE.Vector3(1.92, -0.38, 0.12) },
  { id: 'top-right', color: 0x2f80ff, hit: new THREE.Vector3(1.26, 0.82, 0.12) },
  { id: 'top', color: 0xa855f7, hit: new THREE.Vector3(0, 1.52, 0.12) },
  { id: 'top-left', color: 0xd946ef, hit: new THREE.Vector3(-1.26, 0.82, 0.12) },
  { id: 'left', color: 0x18f5ff, hit: new THREE.Vector3(-1.92, -0.38, 0.12) },
].map((lane) => ({
  ...lane,
  start: new THREE.Vector3(lane.hit.x * 1.24, lane.hit.y - 2.15, -6.4),
}));

const slashTrailColors = [0x18f5ff, 0xa855f7, 0xff4fd8];

const requestSensorPermission = async () => {
  const requests = [];

  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    requests.push(['motion', DeviceMotionEvent.requestPermission()]);
  }

  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    requests.push(['orientation', DeviceOrientationEvent.requestPermission()]);
  }

  const denied = [];
  for (const [name, request] of requests) {
    const result = await request;
    if (result !== 'granted') {
      denied.push(name);
    }
  }

  if (denied.length > 0) {
    throw new Error(`Sensor permission denied: ${denied.join(', ')}`);
  }
};

const buildEmptyPacket = (sessionId) => ({
  sessionId,
  sentAt: Date.now(),
  performanceTime: performance.now(),
  secureContext: window.isSecureContext,
  orientation: {
    alpha: null,
    beta: null,
    gamma: null,
    absolute: null,
    compassHeading: null,
  },
  motion: {
    acceleration: readVector(),
    accelerationIncludingGravity: readVector(),
    rotationRate: readRotationRate(),
    interval: null,
  },
  screen: {
    angle: getScreenAngle(),
    width: window.innerWidth,
    height: window.innerHeight,
  },
});

const QrCode = ({ value }) => {
  const qr = useMemo(() => {
    try {
      return createQrPath(value);
    } catch {
      return null;
    }
  }, [value]);

  if (!qr) {
    return (
      <div className="motion-qr-fallback">
        <Link size={22} />
      </div>
    );
  }

  return (
    <svg
      className="motion-qr"
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      role="img"
      aria-label="Phone pairing QR code"
      shapeRendering="crispEdges"
    >
      <rect width={qr.size} height={qr.size} fill="#ffffff" />
      <path d={qr.path} fill="#000000" />
    </svg>
  );
};

const TelemetryTile = ({ label, value, detail, icon }) => (
  <div className="motion-telemetry-tile">
    <span className="motion-tile-icon">{icon}</span>
    <span className="motion-tile-label">{label}</span>
    <strong>{value}</strong>
    {detail && <small>{detail}</small>}
  </div>
);

const setQuaternionFromDevice = (() => {
  const euler = new THREE.Euler();
  const screenTransform = new THREE.Quaternion();
  const zee = new THREE.Vector3(0, 0, 1);
  const deviceFrameFix = new THREE.Quaternion(
    -Math.sqrt(0.5),
    0,
    0,
    Math.sqrt(0.5)
  );

  return (targetQuaternion, packet) => {
    const orientation = getPacketOrientation(packet);

    if (!hasUsableOrientationPacket(packet)) {
      return false;
    }

    const alpha = THREE.MathUtils.degToRad(orientation.alpha);
    const beta = THREE.MathUtils.degToRad(orientation.beta);
    const gamma = THREE.MathUtils.degToRad(orientation.gamma);
    const screenAngle = THREE.MathUtils.degToRad(packet?.screen?.angle || 0);

    euler.set(beta, alpha, -gamma, 'YXZ');
    targetQuaternion.setFromEuler(euler);
    targetQuaternion.multiply(deviceFrameFix);
    targetQuaternion.multiply(screenTransform.setFromAxisAngle(zee, -screenAngle));
    return true;
  };
})();

const createTaperedBladeGeometry = ({
  baseZ,
  tipZ,
  baseWidth,
  tipWidth,
  baseThickness,
  tipThickness,
}) => {
  const shoulderZ = tipZ - 0.32;
  const vertices = [
    [-baseWidth, 0, baseZ],
    [0, baseThickness, baseZ],
    [baseWidth, 0, baseZ],
    [0, -baseThickness, baseZ],
    [-tipWidth, 0, shoulderZ],
    [0, tipThickness, shoulderZ],
    [tipWidth, 0, shoulderZ],
    [0, -tipThickness, shoulderZ],
    [0, 0, tipZ],
  ];
  const indices = [];
  const addQuad = (a, b, c, d) => {
    indices.push(a, b, d, b, c, d);
  };

  for (let index = 0; index < 4; index += 1) {
    const next = (index + 1) % 4;
    addQuad(index, next, next + 4, index + 4);
    indices.push(index + 4, next + 4, 8);
  }
  indices.push(0, 1, 2, 0, 2, 3);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices.flat(), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
};

const createRoundedBoxGeometry = ({
  width,
  height,
  depth,
  radius,
  segments = 6,
}) => {
  const x = -width / 2;
  const y = -height / 2;
  const roundedRadius = Math.min(radius, width / 2, height / 2);
  const shape = new THREE.Shape();

  shape.moveTo(x + roundedRadius, y);
  shape.lineTo(x + width - roundedRadius, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + roundedRadius);
  shape.lineTo(x + width, y + height - roundedRadius);
  shape.quadraticCurveTo(x + width, y + height, x + width - roundedRadius, y + height);
  shape.lineTo(x + roundedRadius, y + height);
  shape.quadraticCurveTo(x, y + height, x, y + height - roundedRadius);
  shape.lineTo(x, y + roundedRadius);
  shape.quadraticCurveTo(x, y, x + roundedRadius, y);

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelSegments: segments,
    bevelSize: roundedRadius,
    bevelThickness: roundedRadius,
    curveSegments: segments,
    steps: 1,
  });
  geometry.center();
  geometry.computeVertexNormals();
  return geometry;
};

/* ── Plane-based geometry slicer ─────────────────────────────────────────── */

const sliceGeometry = (sourceGeometry, plane) => {
  const posAttr = sourceGeometry.getAttribute('position');
  const indexArray = sourceGeometry.index
    ? sourceGeometry.index.array
    : null;
  const triCount = indexArray
    ? indexArray.length / 3
    : posAttr.count / 3;

  const frontPositions = [];
  const backPositions = [];
  const frontCap = [];  // vertices lying on the plane (for capping)
  const backCap = [];

  const getVertex = (i) => new THREE.Vector3(
    posAttr.getX(i),
    posAttr.getY(i),
    posAttr.getZ(i)
  );

  const classify = (vertex) => plane.distanceToPoint(vertex);

  const interpolateEdge = (vertexA, vertexB, distA, distB) => {
    const t = distA / (distA - distB);
    return new THREE.Vector3().lerpVectors(vertexA, vertexB, t);
  };

  const pushTri = (target, a, b, c) => {
    target.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };

  for (let tri = 0; tri < triCount; tri++) {
    const i0 = indexArray ? indexArray[tri * 3] : tri * 3;
    const i1 = indexArray ? indexArray[tri * 3 + 1] : tri * 3 + 1;
    const i2 = indexArray ? indexArray[tri * 3 + 2] : tri * 3 + 2;

    const v0 = getVertex(i0);
    const v1 = getVertex(i1);
    const v2 = getVertex(i2);

    const d0 = classify(v0);
    const d1 = classify(v1);
    const d2 = classify(v2);

    const s0 = d0 >= 0 ? 1 : -1;
    const s1 = d1 >= 0 ? 1 : -1;
    const s2 = d2 >= 0 ? 1 : -1;

    // All on front side
    if (s0 >= 0 && s1 >= 0 && s2 >= 0) {
      pushTri(frontPositions, v0, v1, v2);
      continue;
    }
    // All on back side
    if (s0 < 0 && s1 < 0 && s2 < 0) {
      pushTri(backPositions, v0, v1, v2);
      continue;
    }

    // Triangle straddles the plane — find the lone vertex
    const verts = [v0, v1, v2];
    const dists = [d0, d1, d2];
    const signs = [s0, s1, s2];

    // Find the vertex that is alone on one side
    const loneIdx = signs[0] !== signs[1] && signs[0] !== signs[2]
      ? 0
      : signs[1] !== signs[0] && signs[1] !== signs[2]
        ? 1
        : 2;

    const pairA = (loneIdx + 1) % 3;
    const pairB = (loneIdx + 2) % 3;

    const intA = interpolateEdge(verts[loneIdx], verts[pairA], dists[loneIdx], dists[pairA]);
    const intB = interpolateEdge(verts[loneIdx], verts[pairB], dists[loneIdx], dists[pairB]);

    const loneSide = signs[loneIdx] >= 0 ? frontPositions : backPositions;
    const pairSide = signs[loneIdx] >= 0 ? backPositions : frontPositions;
    const loneCap = signs[loneIdx] >= 0 ? frontCap : backCap;
    const pairCapArr = signs[loneIdx] >= 0 ? backCap : frontCap;

    // Lone vertex triangle
    pushTri(loneSide, verts[loneIdx], intA, intB);
    loneCap.push(intA.clone(), intB.clone());

    // Pair side — two triangles (quad)
    pushTri(pairSide, intA, verts[pairA], verts[pairB]);
    pushTri(pairSide, intA, verts[pairB], intB);
    pairCapArr.push(intA.clone(), intB.clone());
  }

  // Build cap face from intersection points
  const buildCap = (points, flipNormal) => {
    if (points.length < 4) return [];

    // Compute centroid
    const centroid = new THREE.Vector3();
    points.forEach(p => centroid.add(p));
    centroid.divideScalar(points.length);

    // Build local 2D frame on the plane for sorting
    const normal = plane.normal.clone();
    if (flipNormal) normal.negate();

    let refAxis = new THREE.Vector3(1, 0, 0);
    if (Math.abs(normal.dot(refAxis)) > 0.9) {
      refAxis = new THREE.Vector3(0, 1, 0);
    }
    const u = new THREE.Vector3().crossVectors(normal, refAxis).normalize();
    const v = new THREE.Vector3().crossVectors(normal, u).normalize();

    // Deduplicate points
    const unique = [];
    const seen = new Set();
    for (const p of points) {
      const key = `${(p.x * 1000) | 0},${(p.y * 1000) | 0},${(p.z * 1000) | 0}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(p);
      }
    }

    if (unique.length < 3) return [];

    // Sort by angle around centroid
    unique.sort((a, b) => {
      const da = a.clone().sub(centroid);
      const db = b.clone().sub(centroid);
      return Math.atan2(da.dot(v), da.dot(u)) - Math.atan2(db.dot(v), db.dot(u));
    });

    // Fan triangulation from centroid
    const capPositions = [];
    for (let i = 0; i < unique.length; i++) {
      const next = unique[(i + 1) % unique.length];
      pushTri(capPositions, centroid, unique[i], next);
    }
    return capPositions;
  };

  const frontCapTris = buildCap(frontCap, false);
  const backCapTris = buildCap(backCap, true);

  const buildResult = (positions, capTris) => {
    const shellVertexCount = positions.length / 3;
    const capVertexCount = capTris.length / 3;
    const all = new Float32Array(positions.length + capTris.length);
    all.set(positions);
    all.set(capTris, positions.length);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(all, 3));
    geo.computeVertexNormals();
    // Group 0 = outer shell triangles, Group 1 = cap (inner cross-section) triangles
    geo.addGroup(0, shellVertexCount, 0);
    if (capVertexCount > 0) {
      geo.addGroup(shellVertexCount, capVertexCount, 1);
    }
    return geo;
  };

  return {
    front: buildResult(frontPositions, frontCapTris),
    back: buildResult(backPositions, backCapTris),
  };
};

const PhoneSwordScene = ({ packet, calibrateKey, onBlockScored }) => {
  const mountRef = useRef(null);
  const packetRef = useRef(packet);
  const onBlockScoredRef = useRef(onBlockScored);
  const calibrationSignalRef = useRef(0);

  useEffect(() => {
    packetRef.current = packet;
  }, [packet]);

  useEffect(() => {
    onBlockScoredRef.current = onBlockScored;
  }, [onBlockScored]);

  useEffect(() => {
    calibrationSignalRef.current += 1;
  }, [calibrateKey]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) {
      return undefined;
    }

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x050912, 5, 14);

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 50);
    camera.position.set(0, 1.05, 5.4);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x050912, 1);
    mount.appendChild(renderer.domElement);

    const ambient = new THREE.AmbientLight(0xd9ecff, 1.75);
    const keyLight = new THREE.PointLight(0x18d7ff, 48, 10);
    keyLight.position.set(2.3, 2.7, 2.8);
    const roseLight = new THREE.PointLight(0xff5ea8, 22, 8);
    roseLight.position.set(-2.7, -0.8, 2.2);
    const violetLight = new THREE.PointLight(0x9b5cff, 34, 9);
    violetLight.position.set(-2.1, 2.4, -1.7);
    const laneLight = new THREE.PointLight(0x18f5ff, 26, 11);
    laneLight.position.set(0, -0.7, -2.1);
    scene.add(ambient, keyLight, roseLight, violetLight, laneLight);

    const geometries = [];
    const materials = [];
    const trackGeometry = (geometry) => {
      geometries.push(geometry);
      return geometry;
    };
    const trackMaterial = (material) => {
      materials.push(material);
      return material;
    };

    const rig = new THREE.Group();
    const sword = new THREE.Group();
    sword.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 1, 0)
    );
    const bladeBaseZ = 0.5;
    const bladeTipZ = 3.08;
    const hiltCenterZ = -0.08;

    const bladeMaterial = trackMaterial(new THREE.MeshPhysicalMaterial({
      color: 0xbffcff,
      metalness: 0.18,
      roughness: 0.16,
      emissive: 0x20e7ff,
      emissiveIntensity: 1.35,
      clearcoat: 1,
      clearcoatRoughness: 0.12,
    }));
    const bladeGlowMaterial = trackMaterial(new THREE.MeshBasicMaterial({
      color: 0x18d7ff,
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    const hiltMaterial = trackMaterial(new THREE.MeshPhysicalMaterial({
      color: 0x091220,
      metalness: 0.64,
      roughness: 0.24,
      emissive: 0x072a47,
      emissiveIntensity: 0.48,
      clearcoat: 0.72,
      clearcoatRoughness: 0.2,
    }));
    const guardMaterial = trackMaterial(new THREE.MeshPhysicalMaterial({
      color: 0xffd166,
      metalness: 0.56,
      roughness: 0.2,
      emissive: 0x3b2500,
      emissiveIntensity: 0.22,
      clearcoat: 0.82,
      clearcoatRoughness: 0.18,
    }));
    const accentMaterial = trackMaterial(new THREE.MeshBasicMaterial({
      color: 0x19b8ff,
      transparent: true,
      opacity: 0.78,
      blending: THREE.AdditiveBlending,
    }));
    const hiltGlowMaterial = trackMaterial(new THREE.MeshBasicMaterial({
      color: 0x19b8ff,
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    const phoneMaterial = trackMaterial(new THREE.MeshPhysicalMaterial({
      color: 0x07111d,
      metalness: 0.34,
      roughness: 0.3,
      emissive: 0x0d9bd7,
      emissiveIntensity: 0.22,
      clearcoat: 0.9,
      clearcoatRoughness: 0.16,
    }));
    const edgeMaterial = trackMaterial(new THREE.LineBasicMaterial({
      color: 0x7ce8ff,
      transparent: true,
      opacity: 0.82,
    }));

    const bladeGeometry = trackGeometry(createTaperedBladeGeometry({
      baseZ: bladeBaseZ,
      tipZ: bladeTipZ,
      baseWidth: 0.17,
      tipWidth: 0.055,
      baseThickness: 0.045,
      tipThickness: 0.018,
    }));
    const blade = new THREE.Mesh(bladeGeometry, bladeMaterial);

    const bladeGlow = new THREE.Mesh(
      trackGeometry(createTaperedBladeGeometry({
        baseZ: bladeBaseZ - 0.03,
        tipZ: bladeTipZ + 0.02,
        baseWidth: 0.27,
        tipWidth: 0.095,
        baseThickness: 0.075,
        tipThickness: 0.034,
      })),
      bladeGlowMaterial
    );

    const bladeEdges = new THREE.LineSegments(
      trackGeometry(new THREE.EdgesGeometry(bladeGeometry)),
      edgeMaterial
    );

    const grip = new THREE.Mesh(
      trackGeometry(new THREE.CylinderGeometry(0.065, 0.075, 0.84, 18)),
      hiltMaterial
    );
    grip.rotation.x = Math.PI / 2;
    grip.position.set(0, 0.04, hiltCenterZ);

    const phoneMountGeometry = trackGeometry(new THREE.BoxGeometry(0.3, 0.05, 0.9, 2, 1, 4));
    const phoneMount = new THREE.Mesh(phoneMountGeometry, phoneMaterial);
    phoneMount.position.set(0, -0.105, hiltCenterZ);
    const phoneMountEdges = new THREE.LineSegments(
      trackGeometry(new THREE.EdgesGeometry(phoneMountGeometry)),
      edgeMaterial
    );
    phoneMountEdges.position.copy(phoneMount.position);

    const guard = new THREE.Mesh(
      trackGeometry(new THREE.BoxGeometry(0.9, 0.1, 0.12, 2, 1, 1)),
      guardMaterial
    );
    guard.position.z = bladeBaseZ - 0.08;

    const guardGlow = new THREE.Mesh(
      trackGeometry(new THREE.BoxGeometry(1.06, 0.16, 0.18, 2, 1, 1)),
      hiltGlowMaterial
    );
    guardGlow.position.copy(guard.position);

    const pommel = new THREE.Mesh(
      trackGeometry(new THREE.SphereGeometry(0.115, 24, 12)),
      guardMaterial
    );
    pommel.position.z = -0.62;

    const pivotGlow = new THREE.Mesh(
      trackGeometry(new THREE.SphereGeometry(0.035, 18, 10)),
      accentMaterial
    );
    pivotGlow.position.z = hiltCenterZ;

    [-0.36, 0.16].forEach((zPosition) => {
      const wrap = new THREE.Mesh(
        trackGeometry(new THREE.TorusGeometry(0.095, 0.01, 8, 36)),
        accentMaterial
      );
      wrap.position.z = zPosition;
      sword.add(wrap);
    });

    const guardCapGeometry = trackGeometry(new THREE.SphereGeometry(0.06, 18, 10));
    [-0.49, 0.49].forEach((xPosition) => {
      const cap = new THREE.Mesh(guardCapGeometry, accentMaterial);
      cap.position.set(xPosition, 0, bladeBaseZ - 0.08);
      sword.add(cap);
    });

    sword.add(
      bladeGlow,
      blade,
      bladeEdges,
      guardGlow,
      guard,
      grip,
      phoneMount,
      phoneMountEdges,
      pommel,
      pivotGlow
    );
    rig.add(sword);
    scene.add(rig);

    const grid = new THREE.GridHelper(7, 14, 0x1fd6ff, 0x16314a);
    grid.position.y = swordFloorY;
    grid.material.transparent = true;
    grid.material.opacity = 0.22;
    scene.add(grid);

    const floorGroup = new THREE.Group();
    const floorSurface = new THREE.Mesh(
      trackGeometry(new THREE.PlaneGeometry(4.8, 8.2)),
      trackMaterial(new THREE.MeshBasicMaterial({
        color: 0x071a34,
        transparent: true,
        opacity: 0.58,
        depthWrite: false,
        side: THREE.DoubleSide,
      }))
    );
    floorSurface.rotation.x = -Math.PI / 2;
    floorSurface.position.set(0, swordFloorY - 0.018, -1.58);

    const floorCenterStrip = new THREE.Mesh(
      trackGeometry(new THREE.PlaneGeometry(0.16, 8.2)),
      trackMaterial(new THREE.MeshBasicMaterial({
        color: 0x2cf8ff,
        transparent: true,
        opacity: 0.26,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }))
    );
    floorCenterStrip.rotation.x = -Math.PI / 2;
    floorCenterStrip.position.set(0, swordFloorY - 0.006, -1.58);

    const laneLinePositions = [];
    [-2.25, -1.12, 0, 1.12, 2.25].forEach((xPosition) => {
      laneLinePositions.push(
        xPosition, swordFloorY + 0.006, -5.68,
        xPosition, swordFloorY + 0.006, 2.52
      );
    });
    [-5.68, -3.64, -1.58, 0.48, 2.52].forEach((zPosition) => {
      laneLinePositions.push(
        -2.4, swordFloorY + 0.006, zPosition,
        2.4, swordFloorY + 0.006, zPosition
      );
    });
    const floorLaneGeometry = trackGeometry(new THREE.BufferGeometry().setAttribute(
      'position',
      new THREE.Float32BufferAttribute(laneLinePositions, 3)
    ));
    const floorLaneLines = new THREE.LineSegments(
      floorLaneGeometry,
      trackMaterial(new THREE.LineBasicMaterial({
        color: 0x20f5ff,
        transparent: true,
        opacity: 0.82,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }))
    );
    const floorLaneGlow = new THREE.LineSegments(
      floorLaneGeometry,
      trackMaterial(new THREE.LineBasicMaterial({
        color: 0xa855f7,
        transparent: true,
        opacity: 0.42,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }))
    );

    const swordFloorBase = new THREE.Mesh(
      trackGeometry(new THREE.CircleGeometry(0.18, 32)),
      trackMaterial(new THREE.MeshBasicMaterial({
        color: 0x18f5ff,
        transparent: true,
        opacity: 0.26,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }))
    );
    swordFloorBase.rotation.x = -Math.PI / 2;

    const swordFloorTip = new THREE.Mesh(
      trackGeometry(new THREE.CircleGeometry(0.13, 32)),
      trackMaterial(new THREE.MeshBasicMaterial({
        color: 0xfff1a8,
        transparent: true,
        opacity: 0.38,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }))
    );
    swordFloorTip.rotation.x = -Math.PI / 2;

    floorGroup.add(floorSurface, floorCenterStrip, floorLaneGlow, floorLaneLines, swordFloorBase, swordFloorTip);
    scene.add(floorGroup);

    const blockCoreGeometry = trackGeometry(createRoundedBoxGeometry({
      width: blockCoreSize,
      height: blockCoreSize,
      depth: blockCoreSize,
      radius: 0.075,
    }));
    const blockEdgeGeometry = trackGeometry(new THREE.EdgesGeometry(blockCoreGeometry));
    const blockGroup = new THREE.Group();
    const trailGroup = new THREE.Group();
    const activeBlocks = [];
    const trailSegments = [];
    const colorWhite = new THREE.Color(0xffffff);
    const bladeBaseWorld = new THREE.Vector3();
    const bladeTipWorld = new THREE.Vector3();
    const previousBladeBase = new THREE.Vector3();
    const previousBladeTip = new THREE.Vector3();
    const slashVector = new THREE.Vector3();
    const segmentVector = new THREE.Vector3();
    const pointVector = new THREE.Vector3();
    const projectedPoint = new THREE.Vector3();
    const cutPlane = new THREE.Plane();
    const cutPlaneNormal = new THREE.Vector3();
    const localStrikePoint = new THREE.Vector3();
    const slashDirection = new THREE.Vector3();
    const splitNormal = new THREE.Vector3();
    const cameraRight = new THREE.Vector3();
    const cameraUp = new THREE.Vector3();
    let hasPreviousBlade = false;
    const gameStartAt = performance.now();
    let nextBlockAt = gameStartAt + blockFirstSpawnDelayMs;
    scene.add(blockGroup, trailGroup);

    const tagMaterialOpacity = (material) => {
      material.userData.baseOpacity = material.opacity;
      return material;
    };

    const fadeBlockMaterials = (block, amount) => {
      block.materials.forEach((material) => {
        if (Number.isFinite(material.userData.baseOpacity)) {
          material.opacity = material.userData.baseOpacity * amount;
        }
      });
    };

    const disposeBlock = (block) => {
      blockGroup.remove(block.group);
      block.materials.forEach(material => material.dispose());
      if (block.slicedGeometries) {
        block.slicedGeometries.forEach(geo => geo.dispose());
      }
      block.group.clear();
    };

    const scoreBlock = (result) => {
      onBlockScoredRef.current?.(result);
    };

    const disposeTrailSegment = (segment) => {
      trailGroup.remove(segment.mesh);
      segment.geometry.dispose();
      segment.material.dispose();
    };

    const removeTrailSegment = (index) => {
      disposeTrailSegment(trailSegments[index]);
      trailSegments.splice(index, 1);
    };

    const getDistanceToSegment = (point, start, end) => {
      segmentVector.copy(end).sub(start);
      const lengthSq = segmentVector.lengthSq();

      if (lengthSq <= 0.0001) {
        projectedPoint.copy(start);
        return point.distanceTo(start);
      }

      const amount = THREE.MathUtils.clamp(
        pointVector.copy(point).sub(start).dot(segmentVector) / lengthSq,
        0,
        1
      );
      projectedPoint.copy(start).addScaledVector(segmentVector, amount);
      return projectedPoint.distanceTo(point);
    };

    const createBlock = (lane) => {
      const color = new THREE.Color(lane.color);
      const group = new THREE.Group();
      const bodyMaterial = tagMaterialOpacity(new THREE.MeshPhysicalMaterial({
        color: 0x080e18,
        metalness: 0.52,
        roughness: 0.28,
        emissive: color,
        emissiveIntensity: 0.35,
        transparent: true,
        opacity: 0.94,
        clearcoat: 0.9,
        clearcoatRoughness: 0.14,
        fog: false,
      }));
      const edgeLineMaterial = tagMaterialOpacity(new THREE.LineBasicMaterial({
        color: color.clone().lerp(colorWhite, 0.32),
        transparent: true,
        opacity: 0.88,
        fog: false,
      }));
      const body = new THREE.Mesh(blockCoreGeometry, bodyMaterial);
      const edges = new THREE.LineSegments(blockEdgeGeometry, edgeLineMaterial);
      body.rotation.set(Math.random() * 0.55, Math.random() * 0.35, Math.random() * Math.PI);
      edges.rotation.copy(body.rotation);
      group.add(body, edges);
      group.position.copy(lane.start);
      group.scale.setScalar(0.18);
      blockGroup.add(group);

      const travelDuration = blockTravelDuration + Math.random() * 0.35;
      const forwardVelocity = lane.hit.clone().sub(lane.start).divideScalar(travelDuration);
      activeBlocks.push({
        state: 'active',
        lane,
        group,
        body,
        edges,
        materials: [bodyMaterial, edgeLineMaterial],
        progress: 0,
        travelDuration,
        forwardVelocity,
        cutVelocity: new THREE.Vector3(),
        fallVelocity: 0,
        wobble: Math.random() * Math.PI * 2,
        spin: new THREE.Vector3(
          0.35 + Math.random() * 0.45,
          0.22 + Math.random() * 0.38,
          0.36 + Math.random() * 0.52
        ),
        cutAge: 0,
        cutLife: 0,
        splitSpeed: 0,
        cutSpin: 0,
        pieces: [],
      });
    };

    const cutBlock = (block, motionVector, intensity, strikePoint) => {
      block.state = 'cut';
      scoreBlock('hit');
      block.cutAge = 0;
      block.cutLife = 1.18 + intensity * 0.34;
      block.splitSpeed = 0.28 + intensity * 0.28;
      block.cutSpin = (Math.random() > 0.5 ? 1 : -1) * (0.4 + intensity * 0.85);
      block.cutVelocity.copy(block.forwardVelocity).multiplyScalar(1.08 + intensity * 0.32);
      block.cutVelocity.y = 0;
      block.fallVelocity = -0.36 - intensity * 0.3;
      block.body.visible = false;
      block.edges.visible = false;

      // Compute slash direction in screen-aligned space
      cameraRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
      cameraUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
      slashDirection
        .copy(cameraRight)
        .multiplyScalar(motionVector.dot(cameraRight))
        .addScaledVector(cameraUp, motionVector.dot(cameraUp));
      slashDirection.z = 0;

      if (slashDirection.lengthSq() > 0.0001) {
        slashDirection.normalize();
      } else if (motionVector.lengthSq() > 0.0001) {
        slashDirection.copy(motionVector).setZ(0).normalize();
      } else {
        slashDirection.set(1, 0, 0);
      }

      // splitNormal is perpendicular to the slash in the XY plane
      splitNormal.set(-slashDirection.y, slashDirection.x, 0);
      if (splitNormal.lengthSq() <= 0.0001) {
        splitNormal.set(1, 0, 0);
      }
      splitNormal.normalize();

      // Transform the strike point into the block's local space to place the cut plane
      const worldInverse = new THREE.Matrix4().copy(block.body.matrixWorld).invert();
      localStrikePoint.copy(strikePoint).applyMatrix4(worldInverse);

      // Build the cut plane in local body space
      // The plane normal needs to be in local space too
      cutPlaneNormal.copy(splitNormal);
      // Transform normal direction from world to local (rotation only)
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(worldInverse);
      cutPlaneNormal.applyMatrix3(normalMatrix).normalize();

      // Plane constant: distance from origin along the normal to the strike point
      const planeConstant = -localStrikePoint.dot(cutPlaneNormal);
      cutPlane.set(cutPlaneNormal, planeConstant);

      // Slice the block geometry
      const sliced = sliceGeometry(blockCoreGeometry, cutPlane);

      // Compute centroids for proper piece positioning
      const getCentroid = (geo) => {
        const pos = geo.getAttribute('position');
        const c = new THREE.Vector3();
        for (let i = 0; i < pos.count; i++) {
          c.x += pos.getX(i);
          c.y += pos.getY(i);
          c.z += pos.getZ(i);
        }
        return pos.count > 0 ? c.divideScalar(pos.count) : c;
      };

      const centroidFront = getCentroid(sliced.front);
      const centroidBack = getCentroid(sliced.back);

      // Center each piece geometry on its own centroid
      const centerGeometry = (geo, centroid) => {
        const pos = geo.getAttribute('position');
        for (let i = 0; i < pos.count; i++) {
          pos.setXYZ(i,
            pos.getX(i) - centroid.x,
            pos.getY(i) - centroid.y,
            pos.getZ(i) - centroid.z
          );
        }
        pos.needsUpdate = true;
        geo.computeBoundingSphere();
      };

      centerGeometry(sliced.front, centroidFront);
      centerGeometry(sliced.back, centroidBack);

      // Orient the group so the split normal faces the x-axis (pieces fly apart on local x)
      block.group.rotation.z = Math.atan2(splitNormal.y, splitNormal.x);

      const color = new THREE.Color(block.lane.color);
      const hotColor = color.clone().lerp(colorWhite, 0.54);
      const shellColor = color.clone().lerp(colorWhite, 0.16);

      // Keep sliced pieces colored so hits read as split cubes, not dark debris.
      const shellMaterialA = tagMaterialOpacity(new THREE.MeshPhysicalMaterial({
        color: shellColor,
        metalness: 0.38,
        roughness: 0.24,
        emissive: color.clone(),
        emissiveIntensity: 0.48,
        transparent: true,
        opacity: 0.94,
        clearcoat: 0.9,
        clearcoatRoughness: 0.14,
        fog: false,
        side: THREE.DoubleSide,
      }));
      const shellMaterialB = shellMaterialA.clone();
      tagMaterialOpacity(shellMaterialB);

      // Inner cap material — bright glowing cross-section in the lane color
      const capMaterialA = tagMaterialOpacity(new THREE.MeshBasicMaterial({
        color: hotColor.clone().lerp(colorWhite, 0.38).multiplyScalar(2.5),
        transparent: true,
        opacity: 1.0,
        blending: THREE.AdditiveBlending,
        fog: false,
        side: THREE.DoubleSide,
        depthWrite: false,
        toneMapped: false,
      }));
      const capMaterialB = capMaterialA.clone();
      tagMaterialOpacity(capMaterialB);

      // Multi-material: index 0 = shell, index 1 = cap (matches geometry groups)
      const pieceA = new THREE.Mesh(sliced.front, [shellMaterialA, capMaterialA]);
      const pieceB = new THREE.Mesh(sliced.back, [shellMaterialB, capMaterialB]);

      // Position each piece at its centroid offset
      pieceA.position.copy(centroidFront);
      pieceB.position.copy(centroidBack);

      // Copy the body's local rotation so pieces start aligned with the original block
      pieceA.rotation.copy(block.body.rotation);
      pieceB.rotation.copy(block.body.rotation);

      block.group.add(pieceA, pieceB);
      block.pieces = [pieceA, pieceB];
      block.pieceCentroids = [centroidFront.clone(), centroidBack.clone()];
      block.splitNormal = splitNormal.clone();
      block.materials.push(shellMaterialA, shellMaterialB, capMaterialA, capMaterialB);

      // Track sliced geometries for disposal
      block.slicedGeometries = [sliced.front, sliced.back];
    };

    const createTrailSegment = (fromTip, toTip, intensity) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([
        fromTip.x, fromTip.y, fromTip.z,
        toTip.x, toTip.y, toTip.z,
      ], 3));

      const color = slashTrailColors[Math.min(
        slashTrailColors.length - 1,
        Math.floor(intensity * slashTrailColors.length)
      )];
      const material = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.38 + intensity * 0.44,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const line = new THREE.Line(geometry, material);
      trailGroup.add(line);
      trailSegments.push({
        mesh: line,
        geometry,
        material,
        age: 0,
        life: 0.26 + intensity * 0.18,
        baseOpacity: material.opacity,
      });

      if (trailSegments.length > 34) {
        removeTrailSegment(0);
      }
    };

    const updateTrailSegments = (delta) => {
      for (let index = trailSegments.length - 1; index >= 0; index -= 1) {
        const segment = trailSegments[index];
        segment.age += delta;
        const amount = THREE.MathUtils.clamp(1 - segment.age / segment.life, 0, 1);
        segment.material.opacity = segment.baseOpacity * amount * amount;

        if (amount <= 0) {
          removeTrailSegment(index);
        }
      }
    };

    const updateSwordFloorProjection = () => {
      swordFloorBase.position.set(bladeBaseWorld.x, swordFloorY + 0.044, bladeBaseWorld.z);
      swordFloorTip.position.set(bladeTipWorld.x, swordFloorY + 0.048, bladeTipWorld.z);
    };

    const updateActiveBlock = (block, time, delta, canCut, slashSpeed, slashIntensity) => {
      block.progress += delta / block.travelDuration;
      const travelAmount = block.progress;
      const visibleAmount = THREE.MathUtils.clamp(block.progress, 0, 1);
      block.group.position.lerpVectors(block.lane.start, block.lane.hit, travelAmount);
      block.group.scale.setScalar(0.2 + visibleAmount * 0.68 + Math.sin(time / 170 + block.wobble) * 0.014);
      block.body.rotation.x += block.spin.x * delta;
      block.body.rotation.y += block.spin.y * delta;
      block.body.rotation.z += block.spin.z * delta;
      block.edges.rotation.copy(block.body.rotation);

      if (canCut && slashSpeed > slashCutMinSpeed) {
        const strikeDistance = getDistanceToSegment(block.group.position, bladeBaseWorld, bladeTipWorld);

        if (strikeDistance <= blockCutRadius) {
          cutBlock(block, slashVector, slashIntensity, projectedPoint);
        }
      }
    };

    const updateCutBlock = (block, delta) => {
      block.cutAge += delta;
      const amount = THREE.MathUtils.clamp(block.cutAge / block.cutLife, 0, 1);
      const eased = 1 - Math.pow(1 - amount, 2);

      if (block.pieces.length === 2) {
        // Reset to centroid positions each frame, then push apart
        block.pieces[0].position.copy(block.pieceCentroids[0]);
        block.pieces[1].position.copy(block.pieceCentroids[1]);

        // Push apart along the block's stored split normal
        const splitOffset = eased * block.splitSpeed;
        const bsn = block.splitNormal;
        const dot0 = block.pieceCentroids[0].dot(bsn);
        const dot1 = block.pieceCentroids[1].dot(bsn);
        const sign0 = dot0 >= dot1 ? 1 : -1;

        block.pieces[0].position.addScaledVector(bsn, sign0 * splitOffset);
        block.pieces[1].position.addScaledVector(bsn, -sign0 * splitOffset);

        block.pieces[0].position.y += Math.sin(amount * Math.PI) * 0.06;
        block.pieces[1].position.y += Math.sin(amount * Math.PI) * 0.04;
        block.pieces[0].rotation.z += -delta * 1.8;
        block.pieces[1].rotation.z += delta * 1.8;
      }

      block.fallVelocity -= 1.9 * delta;
      block.group.position.addScaledVector(block.cutVelocity, delta);
      block.group.position.y += block.fallVelocity * delta;
      block.group.rotation.z += block.cutSpin * delta;
      fadeBlockMaterials(block, 1 - amount);
    };

    const updateBlocks = (time, delta, canCut, slashSpeed, slashIntensity) => {
      if (time >= nextBlockAt && activeBlocks.length < maxActiveBlocks) {
        createBlock(blockLaneConfigs[Math.floor(Math.random() * blockLaneConfigs.length)]);
        const rampAmount = THREE.MathUtils.clamp((time - gameStartAt) / blockSpawnRampDurationMs, 0, 1);
        const spawnInterval = THREE.MathUtils.lerp(blockSpawnStartIntervalMs, blockSpawnMinIntervalMs, rampAmount);
        nextBlockAt = time + spawnInterval * (0.88 + Math.random() * 0.28);
      }

      for (let index = activeBlocks.length - 1; index >= 0; index -= 1) {
        const block = activeBlocks[index];

        if (block.state === 'active') {
          updateActiveBlock(block, time, delta, canCut, slashSpeed, slashIntensity);
        } else {
          updateCutBlock(block, delta);
        }

        const missedActiveBlock = block.state === 'active'
          && (block.group.position.z >= rig.position.z || block.progress > 1.35);
        const finishedCutBlock = block.state === 'cut' && block.cutAge >= block.cutLife;

        if (missedActiveBlock || finishedCutBlock) {
          if (missedActiveBlock) {
            scoreBlock('miss');
          }
          disposeBlock(block);
          activeBlocks.splice(index, 1);
        }
      }
    };

    const rawQuaternion = new THREE.Quaternion();
    const targetQuaternion = new THREE.Quaternion();
    const baselineInverse = new THREE.Quaternion();
    const targetPosition = new THREE.Vector3();
    const currentPosition = new THREE.Vector3();
    const rawAcceleration = new THREE.Vector3();
    let hasBaseline = false;
    let lastCalibrationSignal = calibrationSignalRef.current;
    let lastPacketTimestamp = 0;
    let animationFrame = 0;
    let lastTime = performance.now();

    const resize = () => {
      const { clientWidth, clientHeight } = mount;
      const width = Math.max(1, clientWidth);
      const height = Math.max(1, clientHeight);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);
    resize();

    const animate = (time) => {
      const delta = Math.min(0.05, (time - lastTime) / 1000);
      lastTime = time;
      const currentPacket = packetRef.current;
      const hasOrientation = setQuaternionFromDevice(rawQuaternion, currentPacket);
      const packetTimestamp = getPacketTimestamp(currentPacket);
      const motion = getPacketMotion(currentPacket);
      const rotationRate = motion.rotationRate || {};
      const gyroSpeed = Math.hypot(
        Number.isFinite(rotationRate.alpha) ? rotationRate.alpha : 0,
        Number.isFinite(rotationRate.beta) ? rotationRate.beta : 0,
        Number.isFinite(rotationRate.gamma) ? rotationRate.gamma : 0
      );
      const swingAmount = THREE.MathUtils.clamp(
        (gyroSpeed - swordRestGyroThreshold) / (swordFastGyroThreshold - swordRestGyroThreshold),
        0,
        1
      );
      let shouldSnapToBaseline = false;

      if (calibrationSignalRef.current !== lastCalibrationSignal) {
        lastCalibrationSignal = calibrationSignalRef.current;
        hasBaseline = false;
      }

      if (
        hasOrientation
        && packetTimestamp > 0
        && lastPacketTimestamp > 0
        && packetTimestamp - lastPacketTimestamp > orientationReconnectGapMs
      ) {
        hasBaseline = false;
      }

      if (packetTimestamp > lastPacketTimestamp) {
        lastPacketTimestamp = packetTimestamp;
      }

      if (hasOrientation) {
        if (!hasBaseline) {
          baselineInverse.copy(rawQuaternion).invert();
          hasBaseline = true;
          shouldSnapToBaseline = true;
        }

        targetQuaternion.copy(baselineInverse).multiply(rawQuaternion);

        if (shouldSnapToBaseline) {
          rig.quaternion.copy(targetQuaternion);
        } else {
          const angleToTarget = rig.quaternion.angleTo(targetQuaternion);
          const orientationDeadband = THREE.MathUtils.lerp(
            swordRestOrientationDeadband,
            swordFastOrientationDeadband,
            swingAmount
          );

          if (angleToTarget > orientationDeadband) {
            const orientationResponse = THREE.MathUtils.lerp(
              swordRestOrientationResponse,
              swordFastOrientationResponse,
              swingAmount
            );
            rig.quaternion.slerp(targetQuaternion, dampAlpha(orientationResponse, delta));
          }
        }
      } else {
        rig.rotation.y += delta * 0.45;
        rig.rotation.x = Math.sin(time / 1200) * 0.16;
      }

      const acceleration = motion.acceleration || {};
      rawAcceleration.set(
        deadbandValue(acceleration.x, swordAccelerationDeadband),
        deadbandValue(acceleration.y, swordAccelerationDeadband),
        deadbandValue(acceleration.z, swordAccelerationDeadband)
      );
      targetPosition.set(
        THREE.MathUtils.clamp(rawAcceleration.x * 0.045, -0.65, 0.65),
        THREE.MathUtils.clamp(rawAcceleration.y * 0.045, -0.42, 0.42),
        THREE.MathUtils.clamp(rawAcceleration.z * 0.035, -0.48, 0.48)
      );
      const accelerationAmount = THREE.MathUtils.clamp(rawAcceleration.length() / 8, 0, 1);
      const positionResponse = THREE.MathUtils.lerp(
        swordRestPositionResponse,
        swordFastPositionResponse,
        accelerationAmount
      );
      currentPosition.lerp(targetPosition, dampAlpha(positionResponse, delta));
      if (targetPosition.lengthSq() === 0 && currentPosition.lengthSq() < 0.0009) {
        currentPosition.set(0, 0, 0);
      }
      rig.position.copy(swordRestPosition).add(currentPosition);

      bladeBaseWorld.set(0, 0, bladeBaseZ);
      bladeTipWorld.set(0, 0, bladeTipZ);
      sword.localToWorld(bladeBaseWorld);
      sword.localToWorld(bladeTipWorld);
      updateSwordFloorProjection();

      let slashSpeed = 0;
      let slashIntensity = 0;
      let canCut = false;

      if (hasOrientation && !shouldSnapToBaseline) {
        if (hasPreviousBlade && delta > 0) {
          slashVector.copy(bladeTipWorld).sub(previousBladeTip);
          slashSpeed = (slashVector.length() / delta) + gyroSpeed * 0.006;
          slashIntensity = THREE.MathUtils.clamp((slashSpeed - slashTrailMinSpeed) / 6.8, 0, 1);
          canCut = slashSpeed > slashCutMinSpeed;

          if (slashIntensity > slashTrailVisibleMinIntensity) {
            createTrailSegment(previousBladeTip, bladeTipWorld, slashIntensity);
          }
        }

        previousBladeBase.copy(bladeBaseWorld);
        previousBladeTip.copy(bladeTipWorld);
        hasPreviousBlade = true;
      } else {
        slashVector.set(0, 0, 0);
        hasPreviousBlade = false;
      }

      updateTrailSegments(delta);
      updateBlocks(time, delta, canCut, slashSpeed, slashIntensity);

      const glowPulse = 1 + Math.sin(time / 180) * 0.018;
      bladeGlow.scale.set(glowPulse, glowPulse, 1);
      guardGlow.scale.set(1, 1 + Math.sin(time / 220) * 0.025, 1);
      pivotGlow.scale.setScalar(1 + Math.sin(time / 150) * 0.18);
      renderer.render(scene, camera);
      animationFrame = requestAnimationFrame(animate);
    };

    animationFrame = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      mount.removeChild(renderer.domElement);
      while (activeBlocks.length > 0) {
        disposeBlock(activeBlocks.pop());
      }
      while (trailSegments.length > 0) {
        disposeTrailSegment(trailSegments.pop());
      }
      geometries.forEach(geometry => geometry.dispose());
      materials.forEach(material => material.dispose());
      grid.geometry.dispose();
      grid.material.dispose();
      renderer.dispose();
    };
  }, []);

  return <div className="motion-scene" ref={mountRef} aria-label="Live phone orientation scene" />;
};

export const PhoneSensorClient = () => {
  const sessionId = getPhoneSessionId();
  const relayOrigin = useMemo(() => getRelayOrigin(), []);
  const latestPacketRef = useRef(null);
  const seenRef = useRef({ motion: false, orientation: false });
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState(sessionId ? 'idle' : 'missing-session');
  const [statusDetail, setStatusDetail] = useState('');
  const [relayCheck, setRelayCheck] = useState('checking');
  const [sentCount, setSentCount] = useState(0);
  const [listenerCount, setListenerCount] = useState(0);
  const [seen, setSeen] = useState({ motion: false, orientation: false });
  const [preview, setPreview] = useState(() => buildEmptyPacket(sessionId));

  useEffect(() => {
    latestPacketRef.current = preview;
  }, [preview]);

  const markSeen = useCallback((kind) => {
    if (seenRef.current[kind]) {
      return;
    }

    seenRef.current = { ...seenRef.current, [kind]: true };
    setSeen(seenRef.current);
  }, []);

  useEffect(() => {
    let ignore = false;

    fetch(createApiUrl(relayOrigin, configEndpoint))
      .then(response => response.ok ? response.json() : Promise.reject(new Error(`Relay returned ${response.status}`)))
      .then(() => {
        if (!ignore) {
          setRelayCheck('ready');
        }
      })
      .catch(() => {
        if (!ignore) {
          setRelayCheck('unavailable');
        }
      });

    return () => {
      ignore = true;
    };
  }, [relayOrigin]);

  const startSensors = async () => {
    if (!sessionId || isStreaming) {
      return;
    }

    if (relayCheck !== 'ready') {
      setStatus('relay-error');
      setStatusDetail(`No live relay is reachable at ${relayOrigin}.`);
      return;
    }

    try {
      setStatus('requesting');
      setStatusDetail('');
      await requestSensorPermission();
      setIsStreaming(true);
      setStatus('streaming');
    } catch (error) {
      setStatus('blocked');
      setStatusDetail(error.message);
    }
  };

  const stopSensors = () => {
    setIsStreaming(false);
    setStatus('idle');
    setStatusDetail('');
  };

  useEffect(() => {
    if (!isStreaming || !sessionId) {
      return undefined;
    }

    let animationFrame = 0;
    let fallbackTimer = 0;
    let lastSend = 0;
    let lastSentUiUpdate = 0;
    let requestInFlight = false;
    let socket = null;
    let socketReady = false;
    let useHttpFallback = false;
    let stopped = false;
    let sentSinceUiUpdate = 0;

    const updateMotion = (event) => {
      latestPacketRef.current = {
        ...(latestPacketRef.current || buildEmptyPacket(sessionId)),
        motion: {
          acceleration: readVector(event.acceleration),
          accelerationIncludingGravity: readVector(event.accelerationIncludingGravity),
          rotationRate: readRotationRate(event.rotationRate),
          interval: toFiniteNumber(event.interval),
        },
      };
      markSeen('motion');
    };

    const updateOrientation = (event) => {
      latestPacketRef.current = {
        ...(latestPacketRef.current || buildEmptyPacket(sessionId)),
        orientation: {
          alpha: toFiniteNumber(event.alpha),
          beta: toFiniteNumber(event.beta),
          gamma: toFiniteNumber(event.gamma),
          absolute: typeof event.absolute === 'boolean' ? event.absolute : null,
          compassHeading: toFiniteNumber(event.webkitCompassHeading),
        },
      };
      markSeen('orientation');
    };

    const buildPacket = () => {
      const packet = {
        ...(latestPacketRef.current || buildEmptyPacket(sessionId)),
        sessionId,
        sentAt: Date.now(),
        performanceTime: performance.now(),
        secureContext: window.isSecureContext,
        seen: seenRef.current,
        screen: {
          angle: getScreenAngle(),
          width: window.innerWidth,
          height: window.innerHeight,
        },
        userAgent: navigator.userAgent,
      };
      latestPacketRef.current = packet;
      return packet;
    };

    const notePacketSent = (time) => {
      sentSinceUiUpdate += 1;

      if (time - lastSentUiUpdate < 250) {
        return;
      }

      const increment = sentSinceUiUpdate;
      sentSinceUiUpdate = 0;
      lastSentUiUpdate = time;

      if (!stopped) {
        setSentCount(count => count + increment);
      }
    };

    const flushSentCount = () => {
      if (sentSinceUiUpdate <= 0 || stopped) {
        return;
      }

      const increment = sentSinceUiUpdate;
      sentSinceUiUpdate = 0;
      setSentCount(count => count + increment);
    };

    const updateSocketStats = (message) => {
      try {
        const payload = JSON.parse(message.data);

        if (!Number.isFinite(payload.listeners)) {
          return;
        }

        if (!stopped) {
          setListenerCount(payload.listeners);
        }
      } catch (error) {
        console.warn('Motion socket stats were not valid JSON.', error);
      }
    };

    const sendHttpPacket = async (time) => {
      if (requestInFlight) {
        return;
      }

      const packet = buildPacket();
      requestInFlight = true;

      try {
        const response = await fetch(createApiUrl(relayOrigin, publishEndpoint), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(packet),
        });

        if (!response.ok) {
          throw new Error(`Relay returned ${response.status}`);
        }

        const result = await response.json();
        notePacketSent(time);

        if (!stopped) {
          setStatus('streaming');
          setListenerCount(result.listeners || 0);
        }
      } catch (error) {
        if (!stopped && useHttpFallback) {
          setStatus('relay-error');
          setStatusDetail(error.message);
        }
      } finally {
        requestInFlight = false;
      }
    };

    const sendSocketPacket = (time) => {
      if (!socketReady || socket?.readyState !== WebSocket.OPEN) {
        return false;
      }

      if (socket.bufferedAmount > maxSocketBufferedBytes) {
        return false;
      }

      socket.send(JSON.stringify(buildPacket()));
      notePacketSent(time);
      return true;
    };

    try {
      socket = new WebSocket(createSocketUrl(
        relayOrigin,
        `${socketEndpoint}?s=${encodeURIComponent(sessionId)}`
      ));

      socket.addEventListener('open', () => {
        socketReady = true;
        useHttpFallback = false;

        if (!stopped) {
          setStatus('streaming');
          setStatusDetail('');
        }
      });
      socket.addEventListener('message', updateSocketStats);
      socket.addEventListener('error', () => {
        socketReady = false;
        useHttpFallback = true;
      });
      socket.addEventListener('close', () => {
        socketReady = false;
        useHttpFallback = true;

        if (!stopped) {
          setStatusDetail('Fast stream disconnected; using HTTP fallback.');
        }
      });
    } catch (error) {
      useHttpFallback = true;
      console.warn('Motion socket could not start; using HTTP fallback.', error);
    }

    fallbackTimer = window.setTimeout(() => {
      if (!socketReady) {
        useHttpFallback = true;
      }
    }, 1500);

    const tick = (time) => {
      if (time - lastSend >= targetPublishIntervalMs) {
        lastSend = time;

        if (!sendSocketPacket(time) && useHttpFallback) {
          sendHttpPacket(time);
        }
      }

      animationFrame = requestAnimationFrame(tick);
    };

    window.addEventListener('devicemotion', updateMotion);
    window.addEventListener('deviceorientation', updateOrientation);
    animationFrame = requestAnimationFrame(tick);

    return () => {
      flushSentCount();
      stopped = true;
      window.clearTimeout(fallbackTimer);
      cancelAnimationFrame(animationFrame);
      socket?.close();
      window.removeEventListener('devicemotion', updateMotion);
      window.removeEventListener('deviceorientation', updateOrientation);
    };
  }, [isStreaming, markSeen, relayOrigin, sessionId]);

  useEffect(() => {
    if (!isStreaming) {
      return undefined;
    }

    const interval = window.setInterval(() => {
      setPreview(latestPacketRef.current);
    }, 180);

    return () => window.clearInterval(interval);
  }, [isStreaming]);

  const orientation = getPacketOrientation(preview);
  const acceleration = getPacketMotion(preview).acceleration;
  const hasSensorSupport = typeof DeviceMotionEvent !== 'undefined' || typeof DeviceOrientationEvent !== 'undefined';
  const relayUnavailable = relayCheck === 'unavailable';

  return (
    <main className="motion-phone-page">
      <section className="motion-phone-shell">
        <div className="motion-phone-status">
          <span className={`motion-live-dot ${isStreaming ? 'live' : ''}`} />
          <span>{status === 'streaming' ? 'Streaming' : status === 'requesting' ? 'Requesting' : 'Paused'}</span>
        </div>

        <div className="motion-phone-hero">
          <div className="motion-phone-upright" aria-hidden="true">
            <span />
            <Smartphone size={52} />
          </div>
          <h1>Hold your phone like this</h1>
          <p>Straight and vertical, top edge up. Start sensors in this pose so the sword begins upright.</p>
          <small>{sessionId ? `Motion Lab session ${sessionId.toUpperCase()}` : 'No session'}</small>
        </div>

        {!window.isSecureContext && (
          <div className="motion-phone-alert">
            <AlertTriangle size={18} />
            <span>Trusted HTTPS is required by many phone browsers for motion sensors.</span>
          </div>
        )}

        {!hasSensorSupport && (
          <div className="motion-phone-alert">
            <AlertTriangle size={18} />
            <span>This browser does not expose motion or orientation events.</span>
          </div>
        )}

        {relayUnavailable && (
          <div className="motion-phone-alert">
            <AlertTriangle size={18} />
            <span>
              {relayOrigin === window.location.origin
                ? 'This page needs a motion relay before it can send sensor packets.'
                : `Motion relay is not reachable at ${relayOrigin}.`}
            </span>
          </div>
        )}

        {statusDetail && (
          <div className="motion-phone-alert">
            <AlertTriangle size={18} />
            <span>{statusDetail}</span>
          </div>
        )}

        <div className="motion-phone-controls">
          <button
            type="button"
            className="motion-primary-button"
            onClick={startSensors}
            disabled={!sessionId || isStreaming || relayCheck !== 'ready'}
          >
            <Play size={18} />
            {relayCheck === 'checking' ? 'Checking relay' : relayCheck === 'unavailable' ? 'No relay' : 'Start sensors'}
          </button>
          <button
            type="button"
            className="motion-secondary-button"
            onClick={stopSensors}
            disabled={!isStreaming}
          >
            <Square size={16} />
            Stop
          </button>
        </div>

        <div className="motion-phone-grid">
          <TelemetryTile
            label="Packets"
            value={sentCount}
            detail={`${listenerCount} listener${listenerCount === 1 ? '' : 's'}`}
            icon={<RadioTower size={16} />}
          />
          <TelemetryTile
            label="Orientation"
            value={seen.orientation ? 'On' : '--'}
            detail={`${formatMetric(orientation.alpha)} / ${formatMetric(orientation.beta)} / ${formatMetric(orientation.gamma)}`}
            icon={<Compass size={16} />}
          />
          <TelemetryTile
            label="Motion"
            value={seen.motion ? 'On' : '--'}
            detail={formatVector(acceleration)}
            icon={<Activity size={16} />}
          />
        </div>
      </section>
    </main>
  );
};

const MotionLab = () => {
  const relayOrigin = useMemo(() => getRelayOrigin(), []);
  const [sessionId, setSessionId] = useState(createSessionId);
  const [config, setConfig] = useState(null);
  const [relayStatus, setRelayStatus] = useState('connecting');
  const [latestPacket, setLatestPacket] = useState(null);
  const [packetCount, setPacketCount] = useState(0);
  const [packetRate, setPacketRate] = useState(0);
  const [calibrateKey, setCalibrateKey] = useState(0);
  const [isStreamExpanded, setIsStreamExpanded] = useState(false);
  const [isPairPanelExpanded, setIsPairPanelExpanded] = useState(false);
  const [isPairPanelDismissed, setIsPairPanelDismissed] = useState(false);
  const [blockScore, setBlockScore] = useState({ hits: 0, misses: 0 });
  const [now, setNow] = useState(() => Date.now());
  const arrivalTimesRef = useRef([]);

  useEffect(() => {
    let ignore = false;

    fetch(createApiUrl(relayOrigin, configEndpoint))
      .then(response => response.ok ? response.json() : Promise.reject(new Error('Relay config unavailable')))
      .then(payload => {
        if (!ignore) {
          setConfig({ ...payload, relayAvailable: true });
        }
      })
      .catch(() => {
        if (!ignore) {
          setRelayStatus('unavailable');
          setConfig({
            preferredOrigin: window.location.origin,
            localOrigin: window.location.origin,
            lanOrigins: [],
            relayAvailable: false,
            secure: window.isSecureContext,
          });
        }
      });

    return () => {
      ignore = true;
    };
  }, [relayOrigin]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!config || config.relayAvailable === false) {
      return undefined;
    }

    const eventSource = new EventSource(createApiUrl(
      relayOrigin,
      `/api/motion/events?s=${encodeURIComponent(sessionId)}`
    ));

    eventSource.onopen = () => setRelayStatus('ready');
    eventSource.onerror = () => setRelayStatus('reconnecting');
    eventSource.addEventListener('hello', () => setRelayStatus('ready'));
    eventSource.addEventListener('sensor', (event) => {
      const packet = JSON.parse(event.data);
      const arrival = performance.now();
      arrivalTimesRef.current = [...arrivalTimesRef.current, arrival].filter(item => arrival - item <= 1000);
      setPacketRate(arrivalTimesRef.current.length);
      setLatestPacket(packet);
      setPacketCount(count => count + 1);
      setRelayStatus('live');
    });

    return () => eventSource.close();
  }, [config, relayOrigin, sessionId]);

  const phonePageOrigin = relayOrigin === window.location.origin
    ? (config?.preferredOrigin || window.location.origin)
    : window.location.origin;
  const phoneRelayOrigin = relayOrigin === window.location.origin ? phonePageOrigin : relayOrigin;
  const phoneUrl = useMemo(
    () => createPhoneUrl(phonePageOrigin, sessionId, phoneRelayOrigin),
    [phonePageOrigin, phoneRelayOrigin, sessionId]
  );
  const packetAge = latestPacket?.relayReceivedAt ? now - latestPacket.relayReceivedAt : Infinity;
  const isLive = packetAge < 1600;
  const orientation = getPacketOrientation(latestPacket);
  const motion = getPacketMotion(latestPacket);
  const acceleration = motion.acceleration;
  const accelerationWithGravity = motion.accelerationIncludingGravity;
  const rotationRate = motion.rotationRate;
  const secureOrigin = config?.secure || window.isSecureContext;
  const isRelayAvailable = config?.relayAvailable !== false;
  const resolvedBlockCount = blockScore.hits + blockScore.misses;
  const hitPercentage = resolvedBlockCount > 0
    ? Math.round((blockScore.hits / resolvedBlockCount) * 100)
    : null;
  const showPairPanel = (!isLive && !isPairPanelDismissed) || isPairPanelExpanded;
  const labClassName = [
    'motion-lab',
    showPairPanel ? '' : 'pair-hidden',
    isStreamExpanded ? 'stream-expanded' : 'stream-collapsed',
  ].filter(Boolean).join(' ');

  const resetSession = () => {
    setRelayStatus('connecting');
    setSessionId(createSessionId());
    setLatestPacket(null);
    setPacketCount(0);
    setPacketRate(0);
    setBlockScore({ hits: 0, misses: 0 });
    setCalibrateKey(key => key + 1);
    setIsStreamExpanded(false);
    setIsPairPanelExpanded(false);
    setIsPairPanelDismissed(false);
    arrivalTimesRef.current = [];
  };

  const hidePairPanel = () => {
    setIsPairPanelExpanded(false);
    setIsPairPanelDismissed(true);
  };

  const showPairPanelFromViewport = () => {
    setIsPairPanelExpanded(true);
    setIsPairPanelDismissed(false);
  };

  const handleBlockScored = useCallback((result) => {
    setBlockScore(score => ({
      hits: score.hits + (result === 'hit' ? 1 : 0),
      misses: score.misses + (result === 'miss' ? 1 : 0),
    }));
  }, []);

  return (
    <section className={labClassName}>
      {showPairPanel && (
        <div className="motion-win7-window motion-pair-panel" id="motion-pair-panel">
          <div className="motion-win7-glow" aria-hidden="true" />
          <div className="motion-win7-titlebar">
            <div className="motion-win7-title">
              <span className="motion-win7-favicon accent-blue"><Smartphone size={14} /></span>
              <span>Motion Lab</span>
              <small>Session {sessionId.toUpperCase()}</small>
            </div>
            <div className="motion-win7-controls">
              <button type="button" aria-label="Close Motion Lab pairing panel" onClick={hidePairPanel}>
                <Minus size={14} />
              </button>
            </div>
          </div>
          <div className="motion-win7-body">
            <QrCode value={phoneUrl} />

            <div className="motion-url-box">
              <Link size={15} />
              <a href={phoneUrl} target="_blank" rel="noreferrer">{phoneUrl}</a>
            </div>

            <div className="motion-alignment-note">
              <span>Hold the phone straight and vertical before starting sensors. The first live orientation packet becomes the sword's upright zero.</span>
            </div>

            <div className="motion-pair-actions">
              <button type="button" className="motion-secondary-button" onClick={resetSession}>
                <RefreshCw size={16} />
                New session
              </button>
              <button type="button" className="motion-secondary-button" onClick={() => setCalibrateKey(key => key + 1)}>
                <Compass size={16} />
                Calibrate
              </button>
            </div>

            <div className="motion-context-list">
              <span className={secureOrigin ? 'ok' : 'warn'}>
                {secureOrigin ? 'Trusted origin' : 'HTTPS needed for phone sensors'}
              </span>
              <span>{config?.lanOrigins?.[0] ? 'LAN address detected' : 'Using current origin'}</span>
              <span className={isRelayAvailable ? 'ok' : 'warn'}>
                {isRelayAvailable ? 'Local relay ready' : 'Relay unavailable on static hosting'}
              </span>
            </div>
          </div>
        </div>
      )}

      <div className="motion-win7-window motion-viewport-panel">
        <div className="motion-win7-glow" aria-hidden="true" />
        <div className="motion-win7-titlebar">
          <div className="motion-win7-title">
            <span className="motion-win7-favicon accent-cyan"><RadioTower size={14} /></span>
            <span>3D Viewport</span>
            <small>{isLive ? 'Live' : relayStatus === 'unavailable' ? 'No relay' : relayStatus === 'reconnecting' ? 'Waiting' : 'Ready'}</small>
          </div>
          {!isStreamExpanded && (
            <div className="motion-win7-controls">
              <button
                type="button"
                className="motion-titlebar-action"
                onClick={() => setIsStreamExpanded(true)}
                aria-controls="motion-sensor-stream"
                aria-expanded={false}
              >
                <Gauge size={13} />
                Show stream
              </button>
            </div>
          )}
        </div>
        <div className="motion-win7-body motion-viewport-body">
          <PhoneSwordScene
            packet={latestPacket}
            calibrateKey={calibrateKey}
            onBlockScored={handleBlockScored}
          />
          <div className="motion-scene-overlay">
            <div className="motion-scene-left">
              <div className="motion-live-status">
                <span className={`motion-live-dot ${isLive ? 'live' : ''}`} />
                <strong>{isLive ? 'Live' : relayStatus === 'unavailable' ? 'No relay' : relayStatus === 'reconnecting' ? 'Waiting' : 'Ready'}</strong>
                <small>{Number.isFinite(packetAge) ? `${Math.round(packetAge)} ms ago` : relayStatus}</small>
              </div>
              {!showPairPanel && (
                <button
                  type="button"
                  className="motion-overlay-button"
                  onClick={showPairPanelFromViewport}
                  aria-controls="motion-pair-panel"
                  aria-expanded="false"
                >
                  <Smartphone size={15} />
                  Show QR
                </button>
              )}
            </div>
            <div className="motion-scene-actions">
              <div className="motion-scoreboard" aria-label="Cube score">
                <span>
                  <small>Hits</small>
                  <strong>{blockScore.hits}</strong>
                </span>
                <span>
                  <small>Hit %</small>
                  <strong>{hitPercentage === null ? '--' : `${hitPercentage}%`}</strong>
                </span>
              </div>
              <div className="motion-scene-readout">
                <span>Hz {packetRate}</span>
                <span>Packets {packetCount}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {isStreamExpanded && (
        <div className="motion-win7-window motion-data-panel" id="motion-sensor-stream">
          <div className="motion-win7-glow" aria-hidden="true" />
          <div className="motion-win7-titlebar">
            <div className="motion-win7-title">
              <span className="motion-win7-favicon accent-violet"><Gauge size={14} /></span>
              <span>Sensor Stream</span>
              <small>{latestPacket?.seen?.orientation || latestPacket?.seen?.motion ? 'Phone sensors active' : 'No phone packets yet'}</small>
            </div>
            <div className="motion-win7-controls">
              <button type="button" aria-label="Close" className="motion-win7-close" onClick={() => setIsStreamExpanded(false)}>
                <X size={14} />
              </button>
            </div>
          </div>
          <div className="motion-win7-body">
            <div className="motion-telemetry-grid">
              <TelemetryTile
                label="Orientation"
                value={`${formatMetric(orientation.alpha)} deg`}
                detail={`beta ${formatMetric(orientation.beta)} / gamma ${formatMetric(orientation.gamma)}`}
                icon={<Compass size={16} />}
              />
              <TelemetryTile
                label="Accel"
                value={formatVector(acceleration)}
                detail="m/s2, linear"
                icon={<Activity size={16} />}
              />
              <TelemetryTile
                label="Gravity"
                value={formatVector(accelerationWithGravity)}
                detail="m/s2, total"
                icon={<Wifi size={16} />}
              />
              <TelemetryTile
                label="Gyro"
                value={`${formatMetric(rotationRate?.alpha)} / ${formatMetric(rotationRate?.beta)} / ${formatMetric(rotationRate?.gamma)}`}
                detail="deg/s alpha beta gamma"
                icon={<RadioTower size={16} />}
              />
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

export default MotionLab;
