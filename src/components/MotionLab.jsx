import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
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
const feedbackEndpoint = '/api/motion/feedback';
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
const phoneViewportQuery = '(max-width: 760px)';
const blockTravelDuration = 3.2;
const blockFirstSpawnDelayMs = 900;
const blockSpawnStartIntervalMs = 1450;
const blockSpawnMinIntervalMs = 680;
const blockSpawnRampDurationMs = 90_000;
const blockLaneCooldownMs = 1700;
const blockRecentLaneCount = 2;
const maxActiveBlocks = 7;
const slashTrailMinSpeed = 4.2;
const slashTrailVisibleMinIntensity = 0.14;
const slashCutMinSpeed = 2.85;
const blockCutRadius = 0.47;
const blockCoreSize = 0.62;
const swordFloorY = -1.36;
const screenImpactZ = 2.05;

const blockLaneConfigs = [
  { id: 'right', color: 0xff2d55, hit: new THREE.Vector3(1.92, -0.38, 0.12) },
  { id: 'top-right', color: 0x2f80ff, hit: new THREE.Vector3(1.26, 0.82, 0.12) },
  { id: 'top', color: 0xa855f7, hit: new THREE.Vector3(0, 1.52, 0.12) },
  { id: 'top-left', color: 0xd946ef, hit: new THREE.Vector3(-1.26, 0.82, 0.12) },
  { id: 'left', color: 0x18f5ff, hit: new THREE.Vector3(-1.92, -0.38, 0.12) },
].map((lane) => ({
  ...lane,
  // Keep the approach level with the target lane so lower blocks do not rise through the floor.
  start: new THREE.Vector3(lane.hit.x * 1.24, lane.hit.y, -6.4),
}));

const floorScrollSpeed = Math.abs(
  blockLaneConfigs[0].hit.z - blockLaneConfigs[0].start.z
) / blockTravelDuration;
const floorLaneSpacing = 2.06;

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

const usePhoneViewport = () => {
  const [isPhoneViewport, setIsPhoneViewport] = useState(() => (
    typeof window !== 'undefined' ? window.matchMedia(phoneViewportQuery).matches : false
  ));

  useEffect(() => {
    const mediaQuery = window.matchMedia(phoneViewportQuery);
    const handleChange = (event) => setIsPhoneViewport(event.matches);

    mediaQuery.addEventListener('change', handleChange);

    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return isPhoneViewport;
};

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
  const facetedGeometry = geometry.toNonIndexed();
  geometry.dispose();
  facetedGeometry.computeVertexNormals();
  return facetedGeometry;
};

const createGripWrapGeometry = ({
  startZ,
  endZ,
  centerY,
  startRadius,
  endRadius,
  turns = 4.25,
}) => {
  const points = [];
  const pointCount = 96;

  for (let index = 0; index <= pointCount; index += 1) {
    const amount = index / pointCount;
    const angle = amount * Math.PI * 2 * turns;
    const radius = THREE.MathUtils.lerp(startRadius, endRadius, amount);
    points.push(new THREE.Vector3(
      Math.cos(angle) * radius,
      centerY + Math.sin(angle) * radius,
      THREE.MathUtils.lerp(startZ, endZ, amount)
    ));
  }

  return new THREE.TubeGeometry(
    new THREE.CatmullRomCurve3(points),
    pointCount,
    0.008,
    5,
    false
  );
};

/* ── Analytic cube slicer ────────────────────────────────────────────────── */

const sliceEpsilon = 1e-5;

const pushTriangle = (target, a, b, c) => {
  target.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
};

const clipPolygonToPlane = (polygon, plane, keepFront) => {
  const clipped = [];

  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const previous = polygon[(index + polygon.length - 1) % polygon.length];
    const currentDistance = plane.distanceToPoint(current);
    const previousDistance = plane.distanceToPoint(previous);
    const currentInside = keepFront
      ? currentDistance >= -sliceEpsilon
      : currentDistance <= sliceEpsilon;
    const previousInside = keepFront
      ? previousDistance >= -sliceEpsilon
      : previousDistance <= sliceEpsilon;

    if (currentInside !== previousInside) {
      const amount = previousDistance / (previousDistance - currentDistance);
      clipped.push(previous.clone().lerp(current, amount));
    }

    if (currentInside) {
      clipped.push(current.clone());
    }
  }

  const deduped = clipped.filter((point, index) => (
    index === 0 || point.distanceToSquared(clipped[index - 1]) > sliceEpsilon ** 2
  ));

  if (
    deduped.length > 2
    && deduped[0].distanceToSquared(deduped[deduped.length - 1]) <= sliceEpsilon ** 2
  ) {
    deduped.pop();
  }

  return deduped;
};

const sortPointsOnPlane = (points, normal) => {
  const centroid = points.reduce(
    (result, point) => result.add(point),
    new THREE.Vector3()
  ).divideScalar(points.length);
  const reference = Math.abs(normal.x) < 0.8
    ? new THREE.Vector3(1, 0, 0)
    : new THREE.Vector3(0, 1, 0);
  const axisU = new THREE.Vector3().crossVectors(reference, normal).normalize();
  const axisV = new THREE.Vector3().crossVectors(normal, axisU).normalize();

  return [...points].sort((pointA, pointB) => {
    const deltaA = pointA.clone().sub(centroid);
    const deltaB = pointB.clone().sub(centroid);
    return Math.atan2(deltaA.dot(axisV), deltaA.dot(axisU))
      - Math.atan2(deltaB.dot(axisV), deltaB.dot(axisU));
  });
};

const sliceBoxGeometry = (size, plane) => {
  const half = size / 2;
  const vertices = [
    new THREE.Vector3(-half, -half, -half),
    new THREE.Vector3(-half, -half, half),
    new THREE.Vector3(-half, half, -half),
    new THREE.Vector3(-half, half, half),
    new THREE.Vector3(half, -half, -half),
    new THREE.Vector3(half, -half, half),
    new THREE.Vector3(half, half, -half),
    new THREE.Vector3(half, half, half),
  ];
  const faces = [
    [vertices[4], vertices[6], vertices[7], vertices[5]],
    [vertices[1], vertices[3], vertices[2], vertices[0]],
    [vertices[2], vertices[3], vertices[7], vertices[6]],
    [vertices[1], vertices[0], vertices[4], vertices[5]],
    [vertices[1], vertices[5], vertices[7], vertices[3]],
    [vertices[4], vertices[0], vertices[2], vertices[6]],
  ];
  const edges = [
    [0, 1], [0, 2], [0, 4],
    [1, 3], [1, 5], [2, 3],
    [2, 6], [3, 7], [4, 5],
    [4, 6], [5, 7], [6, 7],
  ];
  const capPoints = [];

  const addCapPoint = (point) => {
    if (!capPoints.some(existing => (
      existing.distanceToSquared(point) <= sliceEpsilon ** 2
    ))) {
      capPoints.push(point.clone());
    }
  };

  edges.forEach(([startIndex, endIndex]) => {
    const start = vertices[startIndex];
    const end = vertices[endIndex];
    const startDistance = plane.distanceToPoint(start);
    const endDistance = plane.distanceToPoint(end);

    if (Math.abs(startDistance) <= sliceEpsilon) addCapPoint(start);
    if (Math.abs(endDistance) <= sliceEpsilon) addCapPoint(end);
    if (startDistance * endDistance < -(sliceEpsilon ** 2)) {
      addCapPoint(start.clone().lerp(
        end,
        startDistance / (startDistance - endDistance)
      ));
    }
  });

  const buildHalf = (keepFront) => {
    const shellPositions = [];
    faces.forEach((face) => {
      const clippedFace = clipPolygonToPlane(face, plane, keepFront);
      for (let index = 1; index < clippedFace.length - 1; index += 1) {
        pushTriangle(shellPositions, clippedFace[0], clippedFace[index], clippedFace[index + 1]);
      }
    });

    const capPositions = [];
    if (capPoints.length >= 3) {
      const capNormal = plane.normal.clone().multiplyScalar(keepFront ? -1 : 1);
      const sortedCap = sortPointsOnPlane(capPoints, capNormal);
      for (let index = 1; index < sortedCap.length - 1; index += 1) {
        pushTriangle(capPositions, sortedCap[0], sortedCap[index], sortedCap[index + 1]);
      }
    }

    const shellVertexCount = shellPositions.length / 3;
    const capVertexCount = capPositions.length / 3;
    const positions = new Float32Array(shellPositions.length + capPositions.length);
    positions.set(shellPositions);
    positions.set(capPositions, shellPositions.length);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.addGroup(0, shellVertexCount, 0);
    if (capVertexCount > 0) {
      geometry.addGroup(shellVertexCount, capVertexCount, 1);
    }
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  };

  return {
    front: buildHalf(true),
    back: buildHalf(false),
    cutOutline: capPoints.length >= 3
      ? sortPointsOnPlane(capPoints, plane.normal)
      : [],
  };
};

const getVolumeCentroid = (geometry) => {
  const positions = geometry.getAttribute('position');
  const centroid = new THREE.Vector3();
  const vertexA = new THREE.Vector3();
  const vertexB = new THREE.Vector3();
  const vertexC = new THREE.Vector3();
  const cross = new THREE.Vector3();
  const triangleCenter = new THREE.Vector3();
  let signedVolume = 0;

  for (let index = 0; index < positions.count; index += 3) {
    vertexA.fromBufferAttribute(positions, index);
    vertexB.fromBufferAttribute(positions, index + 1);
    vertexC.fromBufferAttribute(positions, index + 2);
    const tetrahedronVolume = vertexA.dot(cross.crossVectors(vertexB, vertexC)) / 6;
    triangleCenter.copy(vertexA).add(vertexB).add(vertexC);
    centroid.addScaledVector(triangleCenter, tetrahedronVolume);
    signedVolume += tetrahedronVolume;
  }

  if (Math.abs(signedVolume) > sliceEpsilon) {
    return centroid.multiplyScalar(1 / (4 * signedVolume));
  }

  geometry.computeBoundingBox();
  return geometry.boundingBox.getCenter(centroid);
};

const centerGeometry = (geometry, centroid) => {
  geometry.translate(-centroid.x, -centroid.y, -centroid.z);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
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
    const cameraBasePosition = camera.position.clone();
    const cameraLookTarget = new THREE.Vector3(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    const renderPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(renderPixelRatio);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.92;
    renderer.setClearColor(0x050912, 1);
    mount.appendChild(renderer.domElement);

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const environmentMap = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    pmremGenerator.dispose();
    scene.environment = environmentMap;
    scene.environmentIntensity = 0.72;

    const composer = new EffectComposer(renderer);
    const renderPass = new RenderPass(scene, camera);
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(1, 1),
      0.48,
      0.36,
      0.9
    );
    composer.addPass(renderPass);
    composer.addPass(bloomPass);

    const ambient = new THREE.AmbientLight(0xd9ecff, 1.18);
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
      color: 0x5ba9bc,
      metalness: 0.36,
      roughness: 0.34,
      emissive: 0x0d8da5,
      emissiveIntensity: 0.46,
      clearcoat: 0.28,
      clearcoatRoughness: 0.38,
      envMapIntensity: 0.5,
      flatShading: true,
    }));
    const hiltMaterial = trackMaterial(new THREE.MeshPhysicalMaterial({
      color: 0x091220,
      metalness: 0.72,
      roughness: 0.28,
      emissive: 0x072a47,
      emissiveIntensity: 0.28,
      clearcoat: 0.58,
      clearcoatRoughness: 0.24,
    }));
    const guardMaterial = trackMaterial(new THREE.MeshPhysicalMaterial({
      color: 0xffd166,
      metalness: 0.72,
      roughness: 0.24,
      emissive: 0x3b2500,
      emissiveIntensity: 0.16,
      clearcoat: 0.64,
      clearcoatRoughness: 0.2,
    }));
    const accentMaterial = trackMaterial(new THREE.MeshBasicMaterial({
      color: 0x19b8ff,
      transparent: true,
      opacity: 0.82,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    const gripWrapMaterial = trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x168cb3,
      metalness: 0.68,
      roughness: 0.3,
      emissive: 0x0a91c7,
      emissiveIntensity: 0.56,
    }));
    const phoneMaterial = trackMaterial(new THREE.MeshPhysicalMaterial({
      color: 0x07111d,
      metalness: 0.46,
      roughness: 0.34,
      emissive: 0x0d9bd7,
      emissiveIntensity: 0.12,
      clearcoat: 0.72,
      clearcoatRoughness: 0.2,
    }));
    const phoneScreenMaterial = trackMaterial(new THREE.MeshPhysicalMaterial({
      color: 0x020911,
      metalness: 0.08,
      roughness: 0.16,
      emissive: 0x13cfff,
      emissiveIntensity: 0.94,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
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

    const gripWrap = new THREE.Mesh(
      trackGeometry(createGripWrapGeometry({
        startZ: -0.46,
        endZ: 0.3,
        centerY: 0.04,
        startRadius: 0.078,
        endRadius: 0.068,
      })),
      gripWrapMaterial
    );
    const gripCollarGeometry = trackGeometry(new THREE.TorusGeometry(0.079, 0.012, 8, 32));
    const gripCollars = [-0.49, 0.34].map((zPosition) => {
      const collar = new THREE.Mesh(gripCollarGeometry, guardMaterial);
      collar.position.set(0, 0.04, zPosition);
      return collar;
    });

    const phoneMountGeometry = trackGeometry(new RoundedBoxGeometry(0.3, 0.05, 0.86, 4, 0.025));
    const phoneMount = new THREE.Mesh(phoneMountGeometry, phoneMaterial);
    phoneMount.position.set(0, -0.105, hiltCenterZ);
    const phoneScreen = new THREE.Mesh(
      trackGeometry(new RoundedBoxGeometry(0.25, 0.012, 0.66, 4, 0.018)),
      phoneScreenMaterial
    );
    phoneScreen.position.set(0, -0.136, hiltCenterZ - 0.015);
    const phoneCamera = new THREE.Mesh(
      trackGeometry(new THREE.CylinderGeometry(0.018, 0.018, 0.009, 16)),
      accentMaterial
    );
    phoneCamera.position.set(-0.085, -0.146, hiltCenterZ + 0.29);

    const guardCenterZ = bladeBaseZ - 0.08;
    const guardCore = new THREE.Mesh(
      trackGeometry(new RoundedBoxGeometry(0.3, 0.12, 0.18, 4, 0.028)),
      guardMaterial
    );
    guardCore.position.z = guardCenterZ;
    const quillonGeometry = trackGeometry(new THREE.CapsuleGeometry(0.055, 0.28, 5, 12));
    const quillions = [-1, 1].map((side) => {
      const quillon = new THREE.Mesh(quillonGeometry, guardMaterial);
      const direction = new THREE.Vector3(side, 0, -0.28).normalize();
      quillon.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
      quillon.position.set(side * 0.3, 0, guardCenterZ - 0.045);
      return quillon;
    });

    const pommel = new THREE.Mesh(
      trackGeometry(new THREE.DodecahedronGeometry(0.115, 0)),
      guardMaterial
    );
    pommel.position.z = -0.62;

    const pivotGlow = new THREE.Mesh(
      trackGeometry(new THREE.SphereGeometry(0.035, 18, 10)),
      accentMaterial
    );
    pivotGlow.position.z = hiltCenterZ;

    const guardCapGeometry = trackGeometry(new THREE.OctahedronGeometry(0.065, 1));
    [-1, 1].forEach((side) => {
      const cap = new THREE.Mesh(guardCapGeometry, accentMaterial);
      cap.position.set(side * 0.49, 0, guardCenterZ - 0.1);
      sword.add(cap);
    });

    sword.add(
      blade,
      bladeEdges,
      guardCore,
      ...quillions,
      grip,
      gripWrap,
      ...gripCollars,
      phoneMount,
      phoneScreen,
      phoneCamera,
      pommel,
      pivotGlow
    );
    rig.add(sword);
    scene.add(rig);

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

    const longitudinalLaneLinePositions = [];
    [-2.25, -1.12, 0, 1.12, 2.25].forEach((xPosition) => {
      longitudinalLaneLinePositions.push(
        xPosition, swordFloorY + 0.006, -5.68,
        xPosition, swordFloorY + 0.006, 2.52
      );
    });
    const crossLaneLinePositions = [];
    [-3.64, -1.58, 0.48, 2.52].forEach((zPosition) => {
      crossLaneLinePositions.push(
        -2.4, swordFloorY + 0.006, zPosition,
        2.4, swordFloorY + 0.006, zPosition
      );
    });
    const createFloorLinePair = (positions) => {
      const geometry = trackGeometry(new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.Float32BufferAttribute(positions, 3)
      ));
      const lines = new THREE.LineSegments(
        geometry,
        trackMaterial(new THREE.LineBasicMaterial({
          color: 0x20f5ff,
          transparent: true,
          opacity: 0.82,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          fog: true,
        }))
      );
      const glow = new THREE.LineSegments(
        geometry,
        trackMaterial(new THREE.LineBasicMaterial({
          color: 0xa855f7,
          transparent: true,
          opacity: 0.42,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          fog: true,
        }))
      );

      return { lines, glow };
    };
    const longitudinalLaneLines = createFloorLinePair(longitudinalLaneLinePositions);
    const crossLaneLines = createFloorLinePair(crossLaneLinePositions);
    crossLaneLines.lines.material.blending = THREE.NormalBlending;
    crossLaneLines.lines.material.opacity = 0.48;
    crossLaneLines.glow.visible = false;
    const scrollingFloorLines = new THREE.Group();
    scrollingFloorLines.add(crossLaneLines.lines);

    const swordFloorPoolOuterMaterial = trackMaterial(new THREE.MeshBasicMaterial({
      color: 0x8b5cf6,
      transparent: true,
      opacity: 0.075,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    const swordFloorPoolOuter = new THREE.Mesh(
      trackGeometry(new THREE.CircleGeometry(0.82, 48)),
      swordFloorPoolOuterMaterial
    );
    swordFloorPoolOuter.rotation.x = -Math.PI / 2;

    const swordFloorPoolInnerMaterial = trackMaterial(new THREE.MeshBasicMaterial({
      color: 0x18f5ff,
      transparent: true,
      opacity: 0.1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    const swordFloorPoolInner = new THREE.Mesh(
      trackGeometry(new THREE.CircleGeometry(0.48, 48)),
      swordFloorPoolInnerMaterial
    );
    swordFloorPoolInner.rotation.x = -Math.PI / 2;

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
    const floorImpactGroup = new THREE.Group();

    floorGroup.add(
      floorSurface,
      floorCenterStrip,
      longitudinalLaneLines.glow,
      longitudinalLaneLines.lines,
      scrollingFloorLines,
      swordFloorPoolOuter,
      swordFloorPoolInner,
      swordFloorBase,
      swordFloorTip,
      floorImpactGroup
    );
    scene.add(floorGroup);

    const blockCoreGeometry = trackGeometry(new THREE.BoxGeometry(
      blockCoreSize,
      blockCoreSize,
      blockCoreSize
    ));
    const blockEdgeSourceGeometry = trackGeometry(new THREE.EdgesGeometry(blockCoreGeometry));
    const blockEdgeGeometry = trackGeometry(
      new LineSegmentsGeometry().fromEdgesGeometry(blockEdgeSourceGeometry)
    );
    const blockGroup = new THREE.Group();
    const blockTrailGroup = new THREE.Group();
    const trailGroup = new THREE.Group();
    const impactGroup = new THREE.Group();
    const activeBlocks = [];
    const trailSegments = [];
    const floorImpacts = [];
    const hitSparks = [];
    const recentLaneIds = [];
    const laneCooldowns = new Map();
    const colorWhite = new THREE.Color(0xffffff);
    const bladeBaseWorld = new THREE.Vector3();
    const bladeTipWorld = new THREE.Vector3();
    const previousBladeBase = new THREE.Vector3();
    const previousBladeTip = new THREE.Vector3();
    const slashVector = new THREE.Vector3();
    const segmentVector = new THREE.Vector3();
    const pointVector = new THREE.Vector3();
    const projectedPoint = new THREE.Vector3();
    const segmentCandidate = new THREE.Vector3();
    const triangleCandidate = new THREE.Vector3();
    const bladeSweepTriangleA = new THREE.Triangle();
    const bladeSweepTriangleB = new THREE.Triangle();
    const cutPlane = new THREE.Plane();
    const cutPlaneNormal = new THREE.Vector3();
    const localStrikePoint = new THREE.Vector3();
    const slashDirection = new THREE.Vector3();
    const splitNormal = new THREE.Vector3();
    const cameraRight = new THREE.Vector3();
    const cameraUp = new THREE.Vector3();
    let hasPreviousBlade = false;
    let hitStopRemaining = 0;
    let cameraShakeAge = 1;
    let cameraShakeDuration = 0;
    let cameraShakeStrength = 0;
    let audioContext = null;
    const gameStartAt = performance.now();
    let nextBlockAt = gameStartAt + blockFirstSpawnDelayMs;
    scene.add(blockGroup, blockTrailGroup, trailGroup, impactGroup);

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
      blockTrailGroup.remove(block.approachTrail);
      block.materials.forEach(material => material.dispose());
      block.approachTrailGeometry.dispose();
      block.cutRimGeometry?.dispose();
      if (block.slicedGeometries) {
        block.slicedGeometries.forEach(geo => geo.dispose());
      }
      block.group.clear();
    };

    const scoreBlock = (result, detail) => {
      onBlockScoredRef.current?.(result, detail);
    };

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const ensureAudioContext = () => {
      if (!AudioContextClass) {
        return null;
      }

      if (!audioContext) {
        audioContext = new AudioContextClass();
      }

      if (audioContext.state === 'suspended') {
        audioContext.resume().catch(() => {});
      }

      return audioContext;
    };

    const playHitSound = (intensity) => {
      const context = ensureAudioContext();
      if (!context) {
        return;
      }

      const play = () => {
        if (context.state !== 'running') {
          return;
        }

        const now = context.currentTime;
        const gain = context.createGain();
        const body = context.createOscillator();
        const sparkle = context.createOscillator();
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.075 + intensity * 0.055, now + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.17);
        body.type = 'triangle';
        body.frequency.setValueAtTime(260 + intensity * 130, now);
        body.frequency.exponentialRampToValueAtTime(82, now + 0.17);
        sparkle.type = 'sine';
        sparkle.frequency.setValueAtTime(720 + intensity * 420, now);
        sparkle.frequency.exponentialRampToValueAtTime(360, now + 0.09);
        body.connect(gain);
        sparkle.connect(gain);
        gain.connect(context.destination);
        body.start(now);
        sparkle.start(now);
        body.stop(now + 0.18);
        sparkle.stop(now + 0.1);
      };

      if (context.state === 'running') {
        play();
      } else {
        context.resume().then(play).catch(() => {});
      }
    };

    window.addEventListener('pointerdown', ensureAudioContext, { passive: true });
    window.addEventListener('keydown', ensureAudioContext);

    const triggerCameraImpact = (intensity) => {
      hitStopRemaining = Math.max(hitStopRemaining, 0.032 + intensity * 0.016);
      cameraShakeAge = 0;
      cameraShakeDuration = 0.14 + intensity * 0.06;
      cameraShakeStrength = 0.014 + intensity * 0.018;
    };

    const applyCameraShake = (time, delta) => {
      camera.position.copy(cameraBasePosition);

      if (cameraShakeAge < cameraShakeDuration) {
        cameraShakeAge += delta;
        const amount = THREE.MathUtils.clamp(1 - cameraShakeAge / cameraShakeDuration, 0, 1);
        const strength = cameraShakeStrength * amount * amount;
        camera.position.x += Math.sin(time * 0.19) * strength;
        camera.position.y += Math.cos(time * 0.23) * strength * 0.72;
        camera.position.z += Math.sin(time * 0.16 + 0.8) * strength * 0.35;
      }

      camera.lookAt(cameraLookTarget);
    };

    const disposeHitSpark = (spark) => {
      impactGroup.remove(spark.points);
      spark.geometry.dispose();
      spark.material.dispose();
    };

    const createHitSparks = (strikePoint, color, intensity, normal) => {
      const particleCount = 16 + Math.round(intensity * 10);
      const positions = new Float32Array(particleCount * 3);
      const velocities = new Float32Array(particleCount * 3);

      for (let index = 0; index < particleCount; index += 1) {
        const offset = index * 3;
        const side = Math.random() > 0.5 ? 1 : -1;
        const speed = 0.72 + Math.random() * (1.1 + intensity * 0.75);
        positions[offset] = strikePoint.x;
        positions[offset + 1] = strikePoint.y;
        positions[offset + 2] = strikePoint.z;
        velocities[offset] = normal.x * side * speed + (Math.random() - 0.5) * 0.9;
        velocities[offset + 1] = normal.y * side * speed + (Math.random() - 0.2) * 0.9;
        velocities[offset + 2] = normal.z * side * speed + (Math.random() - 0.5) * 0.85;
      }

      const geometry = new THREE.BufferGeometry();
      const positionAttribute = new THREE.BufferAttribute(positions, 3);
      positionAttribute.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute('position', positionAttribute);
      const material = new THREE.PointsMaterial({
        color: color.clone().lerp(colorWhite, 0.42),
        size: 0.035 + intensity * 0.025,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: true,
        sizeAttenuation: true,
      });
      const points = new THREE.Points(geometry, material);
      impactGroup.add(points);
      hitSparks.push({
        points,
        geometry,
        material,
        velocities,
        age: 0,
        life: 0.28 + intensity * 0.16,
      });
    };

    const updateHitSparks = (delta) => {
      for (let sparkIndex = hitSparks.length - 1; sparkIndex >= 0; sparkIndex -= 1) {
        const spark = hitSparks[sparkIndex];
        const positions = spark.geometry.getAttribute('position');
        spark.age += delta;

        for (let index = 0; index < positions.count; index += 1) {
          const offset = index * 3;
          spark.velocities[offset + 1] -= 1.65 * delta;
          positions.setXYZ(
            index,
            positions.getX(index) + spark.velocities[offset] * delta,
            positions.getY(index) + spark.velocities[offset + 1] * delta,
            positions.getZ(index) + spark.velocities[offset + 2] * delta
          );
          spark.velocities[offset] *= 0.985;
          spark.velocities[offset + 1] *= 0.985;
          spark.velocities[offset + 2] *= 0.985;
        }

        positions.needsUpdate = true;
        const amount = THREE.MathUtils.clamp(1 - spark.age / spark.life, 0, 1);
        spark.material.opacity = 0.95 * amount * amount;
        spark.material.size = (0.035 + 0.025 * amount) * amount;

        if (amount <= 0) {
          disposeHitSpark(spark);
          hitSparks.splice(sparkIndex, 1);
        }
      }
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

    const getDistanceToSegment = (point, start, end, target) => {
      segmentVector.copy(end).sub(start);
      const lengthSq = segmentVector.lengthSq();

      if (lengthSq <= 0.0001) {
        target.copy(start);
        return point.distanceTo(start);
      }

      const amount = THREE.MathUtils.clamp(
        pointVector.copy(point).sub(start).dot(segmentVector) / lengthSq,
        0,
        1
      );
      target.copy(start).addScaledVector(segmentVector, amount);
      return target.distanceTo(point);
    };

    const getSweptBladeDistance = (point) => {
      let closestDistance = Infinity;
      const considerCandidate = (distance, candidate) => {
        if (distance < closestDistance) {
          closestDistance = distance;
          projectedPoint.copy(candidate);
        }
      };

      considerCandidate(
        getDistanceToSegment(point, bladeBaseWorld, bladeTipWorld, segmentCandidate),
        segmentCandidate
      );
      considerCandidate(
        getDistanceToSegment(point, previousBladeBase, previousBladeTip, segmentCandidate),
        segmentCandidate
      );

      bladeSweepTriangleA.set(previousBladeBase, previousBladeTip, bladeTipWorld);
      bladeSweepTriangleA.closestPointToPoint(point, triangleCandidate);
      considerCandidate(point.distanceTo(triangleCandidate), triangleCandidate);
      bladeSweepTriangleB.set(previousBladeBase, bladeTipWorld, bladeBaseWorld);
      bladeSweepTriangleB.closestPointToPoint(point, triangleCandidate);
      considerCandidate(point.distanceTo(triangleCandidate), triangleCandidate);

      return closestDistance;
    };

    const disposeFloorImpact = (impact) => {
      floorImpactGroup.remove(impact.ring, impact.flash);
      impact.ring.geometry.dispose();
      impact.ring.material.dispose();
      impact.flash.geometry.dispose();
      impact.flash.material.dispose();
    };

    const createFloorImpact = (strikePoint, color, intensity) => {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.13, 0.17, 40),
        new THREE.MeshBasicMaterial({
          color: color.clone().lerp(colorWhite, 0.32),
          transparent: true,
          opacity: 0.72,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          fog: true,
          side: THREE.DoubleSide,
        })
      );
      const flash = new THREE.Mesh(
        new THREE.CircleGeometry(0.16, 40),
        new THREE.MeshBasicMaterial({
          color: color.clone().lerp(new THREE.Color(0x18f5ff), 0.35),
          transparent: true,
          opacity: 0.18 + intensity * 0.14,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          fog: true,
          side: THREE.DoubleSide,
        })
      );
      [ring, flash].forEach((mesh) => {
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(strikePoint.x, swordFloorY + 0.026, strikePoint.z);
      });
      floorImpactGroup.add(ring, flash);
      floorImpacts.push({
        ring,
        flash,
        age: 0,
        life: 0.46 + intensity * 0.14,
        ringOpacity: ring.material.opacity,
        flashOpacity: flash.material.opacity,
      });

      if (floorImpacts.length > 14) {
        disposeFloorImpact(floorImpacts.shift());
      }
    };

    const createBlock = (lane) => {
      const color = new THREE.Color(lane.color);
      const group = new THREE.Group();
      const bodyMaterial = tagMaterialOpacity(new THREE.MeshPhysicalMaterial({
        color: color.clone().multiplyScalar(0.62),
        metalness: 0.08,
        roughness: 0.48,
        emissive: color,
        emissiveIntensity: 0.2,
        transparent: true,
        opacity: 0.96,
        clearcoat: 0.18,
        clearcoatRoughness: 0.46,
        envMapIntensity: 0.38,
        fog: true,
      }));
      const edgeLineMaterial = tagMaterialOpacity(new LineMaterial({
        color: color.clone().lerp(colorWhite, 0.48),
        linewidth: 2.35,
        transparent: true,
        opacity: 0.96,
        depthWrite: false,
        fog: true,
        alphaToCoverage: true,
      }));
      const body = new THREE.Mesh(blockCoreGeometry, bodyMaterial);
      const edges = new LineSegments2(blockEdgeGeometry, edgeLineMaterial);
      body.rotation.set(Math.random() * 0.55, Math.random() * 0.35, Math.random() * Math.PI);
      edges.rotation.copy(body.rotation);
      group.add(body, edges);
      group.position.copy(lane.start);
      group.scale.setScalar(0.18);
      blockGroup.add(group);

      const travelDuration = blockTravelDuration + Math.random() * 0.35;
      const forwardVelocity = lane.hit.clone().sub(lane.start).divideScalar(travelDuration);
      const approachDirection = forwardVelocity.clone().normalize();
      const approachTrailGeometry = new THREE.ConeGeometry(0.07, 1, 12, 1, true);
      const approachTrailMaterial = tagMaterialOpacity(new THREE.MeshBasicMaterial({
        color: color.clone().lerp(colorWhite, 0.22),
        transparent: true,
        opacity: 0.22,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: true,
        side: THREE.DoubleSide,
      }));
      const approachTrail = new THREE.Mesh(approachTrailGeometry, approachTrailMaterial);
      approachTrail.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), approachDirection);
      blockTrailGroup.add(approachTrail);
      activeBlocks.push({
        state: 'active',
        lane,
        group,
        body,
        edges,
        materials: [
          bodyMaterial,
          edgeLineMaterial,
          approachTrailMaterial,
        ],
        approachDirection,
        approachTrail,
        approachTrailGeometry,
        approachTrailMaterial,
        progress: 0,
        travelDuration,
        forwardVelocity,
        cutVelocity: new THREE.Vector3(),
        missVelocity: new THREE.Vector3(),
        fallVelocity: 0,
        wobble: Math.random() * Math.PI * 2,
        spin: new THREE.Vector3(
          0.35 + Math.random() * 0.45,
          0.22 + Math.random() * 0.38,
          0.36 + Math.random() * 0.52
        ),
        cutAge: 0,
        cutLife: 0,
        missAge: 0,
        missLife: 0,
        missSpin: 0,
        splitSpeed: 0,
        cutSpin: 0,
        pieces: [],
      });
    };

    const cutBlock = (block, motionVector, intensity, strikePoint) => {
      block.state = 'cut';
      scoreBlock('hit', { intensity, color: block.lane.color });
      block.cutAge = 0;
      block.cutLife = 1.18 + intensity * 0.34;
      block.splitSpeed = 0.28 + intensity * 0.28;
      block.cutSpin = (Math.random() > 0.5 ? 1 : -1) * (0.4 + intensity * 0.85);
      block.cutVelocity.copy(block.forwardVelocity).multiplyScalar(1.08 + intensity * 0.32);
      block.cutVelocity.y = 0;
      block.fallVelocity = -0.36 - intensity * 0.3;
      block.body.visible = false;
      block.edges.visible = false;
      block.approachTrail.visible = false;
      createFloorImpact(strikePoint, new THREE.Color(block.lane.color), intensity);

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
      const impactColor = new THREE.Color(block.lane.color);
      triggerCameraImpact(intensity);
      createHitSparks(strikePoint, impactColor, intensity, splitNormal);
      playHitSound(intensity);

      // Transform the strike point into the block's local space to place the cut plane
      const worldInverse = new THREE.Matrix4().copy(block.body.matrixWorld).invert();
      localStrikePoint.copy(strikePoint).applyMatrix4(worldInverse);

      // Build the cut plane in local body space
      // The plane normal needs to be in local space too
      cutPlaneNormal.copy(splitNormal);
      // Transform normal direction from world to local (rotation only)
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(worldInverse);
      cutPlaneNormal.applyMatrix3(normalMatrix).normalize();

      // Keep the strike offset inside the cube so every successful hit produces two solid halves.
      const planeExtent = blockCoreSize * 0.5 * (
        Math.abs(cutPlaneNormal.x)
        + Math.abs(cutPlaneNormal.y)
        + Math.abs(cutPlaneNormal.z)
      );
      const planeConstant = THREE.MathUtils.clamp(
        -localStrikePoint.dot(cutPlaneNormal),
        -planeExtent * 0.72,
        planeExtent * 0.72
      );
      cutPlane.set(cutPlaneNormal, planeConstant);

      const sliced = sliceBoxGeometry(blockCoreSize, cutPlane);
      const cutRimGeometry = new THREE.BufferGeometry().setFromPoints(sliced.cutOutline);
      const cutRimMaterial = tagMaterialOpacity(new THREE.LineBasicMaterial({
        color: impactColor.clone().lerp(colorWhite, 0.72),
        transparent: true,
        opacity: 0.96,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }));
      const cutRim = new THREE.LineLoop(cutRimGeometry, cutRimMaterial);
      cutRim.rotation.copy(block.body.rotation);
      cutRim.renderOrder = 3;
      block.group.add(cutRim);
      block.cutRim = cutRim;
      block.cutRimGeometry = cutRimGeometry;
      const centroidFront = getVolumeCentroid(sliced.front);
      const centroidBack = getVolumeCentroid(sliced.back);

      centerGeometry(sliced.front, centroidFront);
      centerGeometry(sliced.back, centroidBack);

      const color = new THREE.Color(block.lane.color);
      const shellColor = color.clone().multiplyScalar(0.68);

      // Keep sliced pieces colored so hits read as split cubes, not dark debris.
      const shellMaterialA = tagMaterialOpacity(new THREE.MeshPhysicalMaterial({
        color: shellColor,
        metalness: 0.16,
        roughness: 0.42,
        emissive: color.clone(),
        emissiveIntensity: 0.32,
        transparent: true,
        opacity: 0.94,
        clearcoat: 0.2,
        clearcoatRoughness: 0.44,
        envMapIntensity: 0.36,
        fog: false,
        side: THREE.DoubleSide,
      }));
      const shellMaterialB = shellMaterialA.clone();
      tagMaterialOpacity(shellMaterialB);

      // The cut reveals a dark interior with only a subtle reflection of the lane color.
      const capMaterialA = tagMaterialOpacity(new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(0x02040a).lerp(color, 0.035),
        metalness: 0.02,
        roughness: 0.94,
        emissive: color.clone().multiplyScalar(0.015),
        emissiveIntensity: 0.08,
        transparent: true,
        opacity: 0.98,
        fog: true,
        side: THREE.DoubleSide,
      }));
      const capMaterialB = capMaterialA.clone();
      tagMaterialOpacity(capMaterialB);

      // Multi-material: index 0 = shell, index 1 = cap (matches geometry groups)
      const pieceA = new THREE.Mesh(sliced.front, [shellMaterialA, capMaterialA]);
      const pieceB = new THREE.Mesh(sliced.back, [shellMaterialB, capMaterialB]);

      // Preserve the exact pre-cut pose, then move the halves in the group's local space.
      const pieceCenterFront = centroidFront.clone().applyQuaternion(block.body.quaternion);
      const pieceCenterBack = centroidBack.clone().applyQuaternion(block.body.quaternion);
      pieceA.position.copy(pieceCenterFront);
      pieceB.position.copy(pieceCenterBack);
      pieceA.rotation.copy(block.body.rotation);
      pieceB.rotation.copy(block.body.rotation);

      block.group.add(pieceA, pieceB);
      block.pieces = [pieceA, pieceB];
      block.pieceCenters = [pieceCenterFront, pieceCenterBack];
      block.splitNormalLocal = cutPlaneNormal.clone()
        .applyQuaternion(block.body.quaternion)
        .normalize();
      block.materials.push(
        shellMaterialA,
        shellMaterialB,
        capMaterialA,
        capMaterialB,
        cutRimMaterial
      );

      // Track sliced geometries for disposal
      block.slicedGeometries = [sliced.front, sliced.back];
    };

    const missBlock = (block) => {
      block.state = 'missed';
      scoreBlock('miss');
      block.missAge = 0;
      block.missLife = 0.92;
      block.missSpin = (Math.random() > 0.5 ? 1 : -1) * (1.9 + Math.random() * 1.1);
      block.missVelocity.copy(block.forwardVelocity).multiplyScalar(-0.66);
      block.missVelocity.x += (Math.random() - 0.5) * 0.22;
      block.missVelocity.y = 0.48 + Math.random() * 0.16;
      block.approachTrail.visible = false;
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

    const updateFloorImpacts = (delta) => {
      for (let index = floorImpacts.length - 1; index >= 0; index -= 1) {
        const impact = floorImpacts[index];
        impact.age += delta;
        const amount = THREE.MathUtils.clamp(impact.age / impact.life, 0, 1);
        const eased = 1 - Math.pow(1 - amount, 2);
        impact.ring.scale.setScalar(THREE.MathUtils.lerp(0.55, 3.8, eased));
        impact.ring.material.opacity = impact.ringOpacity * Math.pow(1 - amount, 1.7);
        impact.flash.scale.setScalar(THREE.MathUtils.lerp(0.7, 2.2, eased));
        impact.flash.material.opacity = impact.flashOpacity * Math.pow(1 - amount, 2.4);

        if (amount >= 1) {
          disposeFloorImpact(impact);
          floorImpacts.splice(index, 1);
        }
      }
    };

    const updateSwordFloorProjection = () => {
      swordFloorPoolOuter.position.set(bladeBaseWorld.x, swordFloorY + 0.014, bladeBaseWorld.z);
      swordFloorPoolInner.position.set(bladeBaseWorld.x, swordFloorY + 0.018, bladeBaseWorld.z);
      swordFloorBase.position.set(bladeBaseWorld.x, swordFloorY + 0.044, bladeBaseWorld.z);
      swordFloorTip.position.set(bladeTipWorld.x, swordFloorY + 0.048, bladeTipWorld.z);
    };

    const updateActiveBlock = (block, time, delta, canCut, slashSpeed, slashIntensity) => {
      block.progress += delta / block.travelDuration;
      const travelAmount = block.progress;
      const visibleAmount = THREE.MathUtils.clamp(block.progress, 0, 1);
      block.group.position.lerpVectors(block.lane.start, block.lane.hit, travelAmount);
      block.group.scale.setScalar(0.2 + visibleAmount * 0.68 + Math.sin(time / 170 + block.wobble) * 0.014);
      const trailLength = THREE.MathUtils.lerp(0.18, 1.2, 1 - visibleAmount);
      block.approachTrail.position
        .copy(block.group.position)
        .addScaledVector(block.approachDirection, -trailLength * 0.5);
      block.approachTrail.scale.set(1, trailLength, 1);
      block.approachTrailMaterial.opacity = block.approachTrailMaterial.userData.baseOpacity
        * THREE.MathUtils.lerp(0.34, 1, 1 - visibleAmount);
      block.body.rotation.x += block.spin.x * delta;
      block.body.rotation.y += block.spin.y * delta;
      block.body.rotation.z += block.spin.z * delta;
      block.edges.rotation.copy(block.body.rotation);

      if (canCut && slashSpeed > slashCutMinSpeed) {
        const strikeDistance = getSweptBladeDistance(block.group.position);

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
        block.pieces[0].position.copy(block.pieceCenters[0]);
        block.pieces[1].position.copy(block.pieceCenters[1]);

        // Front and back move in opposite directions along the exact local cut normal.
        const splitOffset = eased * block.splitSpeed;
        block.pieces[0].position.addScaledVector(block.splitNormalLocal, splitOffset);
        block.pieces[1].position.addScaledVector(block.splitNormalLocal, -splitOffset);

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

      if (block.cutRim) {
        const rimAmount = THREE.MathUtils.clamp(1 - block.cutAge / 0.16, 0, 1);
        block.cutRim.material.opacity = block.cutRim.material.userData.baseOpacity
          * rimAmount * rimAmount;
      }
    };

    const updateMissedBlock = (block, delta) => {
      block.missAge += delta;
      const amount = THREE.MathUtils.clamp(block.missAge / block.missLife, 0, 1);
      const impact = Math.sin(Math.min(1, block.missAge / 0.16) * Math.PI);

      // Rebound from the front plane, then let gravity pull the block down.
      block.missVelocity.y -= 2.7 * delta;
      block.group.position.addScaledVector(block.missVelocity, delta);
      block.group.rotation.z += block.missSpin * delta;
      block.group.rotation.x += block.missSpin * 0.42 * delta;
      const baseScale = 0.88 * (1 - amount * 0.08);
      block.group.scale.set(
        baseScale * (1 + impact * 0.1),
        baseScale * (1 - impact * 0.13),
        baseScale * (1 + impact * 0.1)
      );
      fadeBlockMaterials(block, THREE.MathUtils.clamp((1 - amount) * 1.9, 0, 1));
    };

    const pickSpawnLane = (time) => {
      const available = blockLaneConfigs.filter((lane) => (
        (laneCooldowns.get(lane.id) || 0) <= time
        && !recentLaneIds.includes(lane.id)
      ));
      const fallback = blockLaneConfigs.filter((lane) => (
        lane.id !== recentLaneIds[recentLaneIds.length - 1]
      ));
      const candidates = available.length > 0 ? available : fallback;
      const lane = candidates[Math.floor(Math.random() * candidates.length)];

      laneCooldowns.set(lane.id, time + blockLaneCooldownMs);
      recentLaneIds.push(lane.id);
      if (recentLaneIds.length > blockRecentLaneCount) {
        recentLaneIds.shift();
      }

      return lane;
    };

    const updateBlocks = (time, delta, canCut, slashSpeed, slashIntensity) => {
      if (time >= nextBlockAt && activeBlocks.length < maxActiveBlocks) {
        createBlock(pickSpawnLane(time));
        const rampAmount = THREE.MathUtils.clamp((time - gameStartAt) / blockSpawnRampDurationMs, 0, 1);
        const spawnInterval = THREE.MathUtils.lerp(blockSpawnStartIntervalMs, blockSpawnMinIntervalMs, rampAmount);
        nextBlockAt = time + spawnInterval * (0.88 + Math.random() * 0.28);
      }

      for (let index = activeBlocks.length - 1; index >= 0; index -= 1) {
        const block = activeBlocks[index];

        if (block.state === 'active') {
          updateActiveBlock(block, time, delta, canCut, slashSpeed, slashIntensity);
        } else if (block.state === 'cut') {
          updateCutBlock(block, delta);
        } else {
          updateMissedBlock(block, delta);
        }

        const missedActiveBlock = block.state === 'active'
          && (block.group.position.z >= screenImpactZ || block.progress > 1.35);
        const finishedCutBlock = block.state === 'cut' && block.cutAge >= block.cutLife;
        const finishedMissedBlock = block.state === 'missed' && block.missAge >= block.missLife;

        if (missedActiveBlock) {
          missBlock(block);
        }

        if (finishedCutBlock || finishedMissedBlock) {
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
    const worldAcceleration = new THREE.Vector3();
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
      composer.setSize(width, height);
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);
    resize();

    const animate = (time) => {
      const delta = Math.min(0.05, (time - lastTime) / 1000);
      lastTime = time;
      camera.position.copy(cameraBasePosition);
      camera.lookAt(cameraLookTarget);

      if (hitStopRemaining > 0) {
        hitStopRemaining = Math.max(0, hitStopRemaining - delta);
        applyCameraShake(time, delta);
        composer.render(delta);
        animationFrame = requestAnimationFrame(animate);
        return;
      }

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
      worldAcceleration.copy(rawAcceleration);
      if (hasOrientation) {
        worldAcceleration.applyQuaternion(rig.quaternion);
      }
      targetPosition.set(
        THREE.MathUtils.clamp(worldAcceleration.x * 0.045, -0.65, 0.65),
        THREE.MathUtils.clamp(worldAcceleration.y * 0.045, -0.42, 0.42),
        THREE.MathUtils.clamp(worldAcceleration.z * 0.035, -0.48, 0.48)
      );
      const accelerationAmount = THREE.MathUtils.clamp(worldAcceleration.length() / 8, 0, 1);
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
      updateFloorImpacts(delta);
      updateHitSparks(delta);
      const floorTravelDistance = ((time - gameStartAt) / 1000) * floorScrollSpeed;
      scrollingFloorLines.position.z = floorTravelDistance % floorLaneSpacing;
      updateBlocks(time, delta, canCut, slashSpeed, slashIntensity);

      bladeMaterial.emissiveIntensity = 0.46 + Math.sin(time / 180) * 0.025;
      phoneScreenMaterial.emissiveIntensity = 0.94 + Math.sin(time / 260 + 0.6) * 0.07;
      pivotGlow.scale.setScalar(1 + Math.sin(time / 150) * 0.18);
      const floorPoolPulse = 1 + Math.sin(time / 520) * 0.055;
      swordFloorPoolOuter.scale.setScalar(floorPoolPulse);
      swordFloorPoolInner.scale.setScalar(1 + Math.sin(time / 430 + 0.8) * 0.04);
      applyCameraShake(time, delta);
      composer.render(delta);
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
      while (floorImpacts.length > 0) {
        disposeFloorImpact(floorImpacts.pop());
      }
      while (hitSparks.length > 0) {
        disposeHitSpark(hitSparks.pop());
      }
      window.removeEventListener('pointerdown', ensureAudioContext);
      window.removeEventListener('keydown', ensureAudioContext);
      audioContext?.close().catch(() => {});
      geometries.forEach(geometry => geometry.dispose());
      materials.forEach(material => material.dispose());
      environmentMap.dispose();
      bloomPass.dispose();
      composer.dispose();
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

    const handleSocketMessage = (message) => {
      try {
        const payload = JSON.parse(message.data);

        if (payload.type === 'feedback' && payload.feedback === 'hit') {
          const intensity = THREE.MathUtils.clamp(Number(payload.intensity) || 0, 0, 1);
          navigator.vibrate?.([
            Math.round(18 + intensity * 24),
            18,
            Math.round(10 + intensity * 12),
          ]);
          return;
        }

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
      socket.addEventListener('message', handleSocketMessage);
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
  const isPhoneViewport = usePhoneViewport();
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
    if (isPhoneViewport) {
      return undefined;
    }

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
  }, [isPhoneViewport, relayOrigin]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (isPhoneViewport) {
      return undefined;
    }

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
  }, [config, isPhoneViewport, relayOrigin, sessionId]);

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

  const handleBlockScored = useCallback((result, detail = {}) => {
    setBlockScore(score => ({
      hits: score.hits + (result === 'hit' ? 1 : 0),
      misses: score.misses + (result === 'miss' ? 1 : 0),
    }));

    if (result === 'hit' && isRelayAvailable) {
      fetch(createApiUrl(relayOrigin, feedbackEndpoint), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          feedback: 'hit',
          intensity: detail.intensity || 0,
          color: detail.color,
        }),
      }).catch(() => {});
    }
  }, [isRelayAvailable, relayOrigin, sessionId]);

  if (isPhoneViewport) {
    return (
      <section className="motion-lab-phone-message" role="status" aria-live="polite">
        <div className="motion-lab-phone-message-panel">
          <span className="motion-lab-phone-message-icon">
            <Smartphone size={36} />
          </span>
          <h1>Best viewed on larger screens</h1>
          <p>Motion Lab uses a desktop viewport for the 3D scene and pairing controls.</p>
        </div>
      </section>
    );
  }

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
