// What picking a search result does (src/search.js finds them). A part: switch
// its system on, show its sub-group if hidden, peel back the layers above it,
// then let the viewer frame it, fade what is in front of it and select it, so
// its info opens as if it had been clicked. A not-shown entry: say it is not
// shown and why. Everything goes through `host`, so this runs without a browser.

/**
 * @param {{
 *   showLayer: (layerId: string) => Promise<void>,
 *   findMesh: (layerId: string, meshName: string) => object | null,
 *   isGroupVisible: (layerId: string, groupId: string) => boolean,
 *   showGroup: (layerId: string, groupId: string) => void,
 *   unpeel: (layerId: string, mesh: object) => void,
 *   focus: (mesh: object) => void,
 *   showNotShown: (entry: object) => void,
 *   showMissing: (entry: object) => void,
 * }} host
 * @returns {(entry: object) => Promise<void>} picks a search result; a later pick wins over one still loading
 */
export function searchSelector(host) {
  let latest = 0;
  return async function pick(entry) {
    const ticket = ++latest;
    if (entry.kind === 'notShown') {
      host.showNotShown(entry);
      return;
    }
    await host.showLayer(entry.layerId);
    if (ticket !== latest) return; // another result was picked while this layer loaded
    const mesh = host.findMesh(entry.layerId, entry.meshName);
    if (!mesh) {
      host.showMissing(entry);
      return;
    }
    const group = mesh.userData.group;
    if (group && !host.isGroupVisible(entry.layerId, group)) host.showGroup(entry.layerId, group);
    host.unpeel(entry.layerId, mesh);
    host.focus(mesh);
  };
}

/**
 * Where to put the camera to frame a part: looking at its centre from outside
 * the body on its own side (from the current direction for parts near the
 * midline), slightly from above, far enough back that the whole part fits.
 * Plain { x, y, z } objects in, so it is testable without three.js.
 * @param {{ center: {x,y,z}, radius: number, camera: {x,y,z}, fov: number, aspect: number, minDistance: number, maxDistance: number, raise?: number }} opts
 *   `fov` is the vertical field of view in degrees; `raise` (0..1) shows the
 *   part that fraction of the view height above the middle and fits it in the
 *   rest, for screens where a panel covers the bottom
 * @returns {{ position: {x,y,z}, target: {x,y,z}, distance: number }}
 */
export function frameView({ center, radius, camera, fov, aspect, minDistance, maxDistance, raise = 0 }) {
  const horizontal = (x, z) => {
    const length = Math.hypot(x, z);
    return length > 1e-6 ? { x: x / length, z: z / length } : null;
  };
  // The body stands on the y axis, so a part's offset from it says which way is "outside".
  const outward = Math.hypot(center.x, center.z) > 0.05 ? horizontal(center.x, center.z) : null;
  const current = horizontal(camera.x - center.x, camera.z - center.z) ?? { x: 0, z: 1 };
  const flat = outward ? horizontal(outward.x + 0.6 * current.x, outward.z + 0.6 * current.z) ?? current : current;
  const lift = 0.3;
  const norm = Math.hypot(flat.x, lift, flat.z);
  const dir = { x: flat.x / norm, y: lift / norm, z: flat.z / norm };

  const vertical = (fov * Math.PI) / 180;
  const across = 2 * Math.atan(Math.tan(vertical / 2) * aspect);
  const half = Math.min(vertical, across) / 2;
  const fit = (radius / Math.sin(half)) * 1.25 / (1 - 2 * raise);
  const distance = Math.min(Math.max(fit, minDistance), maxDistance);
  // Aim below the part (both camera and target move down) so it shows higher up.
  const drop = raise * 2 * distance * Math.tan(vertical / 2);
  return {
    target: { x: center.x, y: center.y - drop, z: center.z },
    position: { x: center.x + dir.x * distance, y: center.y + dir.y * distance - drop, z: center.z + dir.z * distance },
    distance,
  };
}
