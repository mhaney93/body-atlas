# Extracts parts that BodyParts3D lacks from the Z-Anatomy Blender template
# into data-sources/z-anatomy/ (licenses: README "Anatomy model"), which
# scripts/build-models.mjs then aligns onto the BodyParts3D model.
#
# Usage (Blender 4.x or later; see README "Rebuilding the models"):
#   blender -b --factory-startup --disable-autoexec Startup.blend \
#     --python scripts/extract-z-anatomy.py -- data-sources/z-anatomy .cache/bodyparts3d/obj
#
# Everything except the connective tissue is written in Z-Anatomy world space
# (metres, +Z up, -Y anterior).
#
# - Bones and glands (coccyx.obj, parotid-gland-*.obj, ossicles/): each OBJ
#   header records an anchor point on the part it attaches to or sits beside,
#   computed the same way the build script computes it on the BodyParts3D
#   mesh, so the build can translate the part into place.
# - Nervous system (nervous/): brain regions and other meshes as OBJ files,
#   the nerves (Bezier curves in Z-Anatomy) sampled into polylines with a
#   radius per point (nerves.json), and sample points of the bones the build
#   uses as landmarks to warp it all onto the BodyParts3D skeleton
#   (landmarks.json).
# - Joints & connective tissue (connective-tissue.obj.gz): the ligaments,
#   joint capsules, menisci and other joint parts plus the deep fasciae,
#   already moved into BodyParts3D space (millimetres). Ligaments must meet
#   the bones they join, so this fit is finer than the nervous system's: every
#   Z-Anatomy bone with a BodyParts3D twin (carpals and tarsals included) is
#   registered onto it (scale, rotation, translation; long bones piece by
#   piece), and each vertex follows the bones nearest to it, blended by
#   distance. That needs the BodyParts3D meshes (npm run fetch-data).
#
# Meshes are read as stored, except those with modifiers (the spinal cord is
# a short segment arrayed and bent along a curve), which are evaluated first.
import gzip
import json
import os
import re
import sys

import bpy
import numpy as np
from mathutils.geometry import interpolate_bezier
from mathutils.kdtree import KDTree

# Z-Anatomy object -> (output file, display name, anchor object, anchor rule)
PARTS = {
    'Coccyx': ('coccyx.obj', 'Coccyx', 'Sacrum', 'lowest'),
    # Placed by the neighbouring submandibular gland, which both models have.
    'Parotid gland.l': ('parotid-gland-left.obj', 'Left parotid gland', 'Submandibular gland.l', 'center'),
    'Parotid gland.r': ('parotid-gland-right.obj', 'Right parotid gland', 'Submandibular gland.r', 'center'),
}

# The auditory ossicles, which Z-Anatomy adapted from the University of
# Dundee's "Anatomy of the Inner Ear" (CC BY-NC-SA 4.0). They go into their
# own subfolder because of that non-commercial license.
OSSICLES_DIR = 'ossicles'
OSSICLES = {
    f'{bone}.{s}': (f'{bone.lower()}-{side}.obj', f'{side.capitalize()} {bone.lower()}', f'Temporal bone.{s}', 'center')
    for bone in ('Malleus', 'Incus', 'Stapes')
    for s, side in (('l', 'left'), ('r', 'right'))
}

out_dir = sys.argv[sys.argv.index('--') + 1]
bp3d_dir = sys.argv[sys.argv.index('--') + 2]


def world_vertices(obj):
    return [obj.matrix_world @ v.co for v in obj.data.vertices]


def anchor(obj, rule):
    verts = world_vertices(obj)
    if rule == 'lowest':
        # Centroid of the lowest 2% of vertices (e.g. the sacrum's apex).
        verts.sort(key=lambda v: v.z)
        n = max(1, len(verts) // 50)
        return [sum(v[i] for v in verts[:n]) / n for i in range(3)]
    if rule == 'center':
        # Centre of the bounding box (e.g. of the temporal bone).
        return [(min(v[i] for v in verts) + max(v[i] for v in verts)) / 2 for i in range(3)]
    raise ValueError(rule)


def obj_lines(objs, digits=6):
    """OBJ vertex and face lines for one or more meshes merged together."""
    verts, faces = [], []
    for obj in objs:
        base = len(verts)
        mesh = obj.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh() if obj.modifiers else obj.data
        verts += [obj.matrix_world @ v.co for v in mesh.vertices]
        # A mirrored object (negative scale) would otherwise turn inside out.
        flip = obj.matrix_world.determinant() < 0
        for poly in mesh.polygons:
            idx = [base + i + 1 for i in poly.vertices]
            if flip:
                idx.reverse()
            for k in range(1, len(idx) - 1):
                faces.append(f'f {idx[0]} {idx[k]} {idx[k + 1]}')
    return [f'v {v.x:.{digits}f} {v.y:.{digits}f} {v.z:.{digits}f}' for v in verts] + faces


def extract(parts, directory, source):
    os.makedirs(directory, exist_ok=True)
    for name, (filename, label, anchor_name, rule) in parts.items():
        obj = bpy.data.objects[name]
        a = anchor(bpy.data.objects[anchor_name], rule)
        lines = [
            f'# Extracted from {source}',
            f'# English name : {label}',
            f'# Anchor : {anchor_name} {rule} {a[0]:.6f} {a[1]:.6f} {a[2]:.6f}',
        ]
        lines += obj_lines([obj])
        with open(os.path.join(directory, filename), 'w') as f:
            f.write('\n'.join(lines) + '\n')
        print(f'Wrote {filename}: {len(obj.data.vertices)} vertices')


extract(PARTS, out_dir, 'Z-Anatomy (https://www.z-anatomy.com), CC BY-SA 4.0')
extract(
    OSSICLES,
    os.path.join(out_dir, OSSICLES_DIR),
    'Z-Anatomy (https://www.z-anatomy.com), adapted from "Anatomy of the Inner Ear" '
    'by the University of Dundee School of Medicine, CC BY-NC-SA 4.0',
)

# --- Nervous system ---------------------------------------------------------

nervous_dir = os.path.join(out_dir, 'nervous')
os.makedirs(nervous_dir, exist_ok=True)
objects = bpy.data.objects


def meshes_under(group):
    """Real meshes (not Z-Anatomy's 2-vertex label joints) below a label object."""
    return [o for o in objects[group].children_recursive if o.type == 'MESH' and len(o.data.vertices) > 2]


def side_of(obj):
    if obj.name.endswith('.l'):
        return 'Left'
    if obj.name.endswith('.r'):
        return 'Right'
    return None


# Cortex: each lobe is the gyri and sulci Z-Anatomy files under it, plus the
# interlobar sulci assigned to the lobe whose surface they continue.
LOBES = {
    'frontal lobe': ('Frontal lobe.g', ['Central sulcus']),
    'parietal lobe': ('Parietal lobe.g', ['Parieto-occipital sulcus', 'Subparietal sulcus', 'Sulcus interm_prim-Jensen']),
    'occipital lobe': ('Occipital lobe.g', ['Anterior occipital sulcus*', ' Posterior transverse collateral sulcus']),
    'temporal lobe': ('Temporal lobe.g', ['Collateral sulcus', 'Lat_Fis-post']),
    'insula': ('Insula.g', ['Circular sulcus of insula']),
    'limbic lobe': ('Limbic lobe.g', []),
}

# Unpaired regions: output name -> objects merged into it.
REGIONS = {
    'Cerebellum': meshes_under('Cerebellum.g'),
    'Brainstem': [
        objects[n]
        for base in ('Midbrain', 'Base of peduncle', 'Pons', 'Medulla oblongata')
        for n in (f'{base}.l', f'{base}.r')
    ],
    'Optic chiasm': [objects['Optic chiasm.l'], objects['Optic chiasm.r']],
    'Spinal cord': [objects['White matter of spinal cord']],
}

# Paired meshes: Z-Anatomy base name -> output base name.
PAIRED = {
    'Optic tract': 'optic tract',
    'Ganglia of sympathetic trunk': 'ganglia of sympathetic trunk',
    'Spinal ganglion': 'spinal ganglia',
}

outputs = {}  # file stem -> (display name, objects)
for lobe, (group, extras) in LOBES.items():
    members = meshes_under(group) + [objects[f'{e}.{s}'] for e in extras for s in 'lr']
    for side in ('Left', 'Right'):
        objs = [o for o in members if side_of(o) == side]
        outputs[f'{side.lower()}-{lobe.replace(" ", "-")}'] = (f'{side} {lobe}', objs)
for label, objs in REGIONS.items():
    outputs[label.lower().replace(' ', '-')] = (label, objs)
for base, label in PAIRED.items():
    for side, suffix in (('Left', 'l'), ('Right', 'r')):
        outputs[f'{side.lower()}-{label.replace(" ", "-")}'] = (f'{side} {label}', [objects[f'{base}.{suffix}']])

for stem, (label, objs) in outputs.items():
    lines = [
        '# Extracted from Z-Anatomy (https://www.z-anatomy.com), CC BY-SA 4.0',
        f'# English name : {label}',
        '# Sources : ' + ', '.join(sorted(o.name for o in objs)),
    ]
    body = obj_lines(objs, digits=5)  # 0.01 mm
    with open(os.path.join(nervous_dir, f'{stem}.obj'), 'w') as f:
        f.write('\n'.join(lines + body) + '\n')
    print(f'Wrote nervous/{stem}.obj: {sum(l.startswith("v ") for l in body)} vertices')


def sample_curve(obj, steps=8):
    """Polylines [[x, y, z, radius], ...] in world space for a bevelled curve."""
    curve = obj.data
    mw = obj.matrix_world
    scale = abs(mw.to_scale()[0])
    lines = []
    for spline in curve.splines:
        pts = spline.bezier_points
        if len(pts) < 2:
            continue
        line = []
        for a, b in zip(pts[:-1], pts[1:]):
            seg = interpolate_bezier(a.co, a.handle_right, b.handle_left, b.co, steps + 1)
            # Each segment after the first starts where the previous one ended.
            for k in range(1 if line else 0, steps + 1):
                t = k / steps
                r = (a.radius * (1 - t) + b.radius * t) * curve.bevel_depth * scale
                w = mw @ seg[k]
                line.append([round(w.x, 5), round(w.y, 5), round(w.z, 5), round(r, 6)])
        lines.append(line)
    return lines


def clean_name(name):
    base = (name[:-2] if name[-2:] in ('.l', '.r') else name).strip()
    # e.g. "(Communicating branch of median nerve with ulnar nerve)"
    return base[1:-1] if base.startswith('(') and base.endswith(')') else base


nerves = []
for obj in objects['Peripheral nervous system.g'].children_recursive:
    if obj.type != 'CURVE' or not obj.data.splines:
        continue
    side = side_of(obj)
    if side is None:
        # A few paired curves lack the suffix; patient-left is +X in Z-Anatomy.
        bb = [obj.matrix_world @ v.co for s in obj.data.splines for v in s.bezier_points]
        cx = sum(v.x for v in bb) / len(bb)
        side = None if abs(cx) < 0.01 else ('Left' if cx > 0 else 'Right')
    nerves.append({
        'source': obj.name,
        'name': clean_name(obj.name),
        'side': side,
        'group': obj.parent.name.removesuffix('.g') if obj.parent else None,
        'lines': sample_curve(obj),
    })
with open(os.path.join(nervous_dir, 'nerves.json'), 'w') as f:
    json.dump(nerves, f, separators=(',', ':'))
print(f'Wrote nervous/nerves.json: {len(nerves)} nerves')

# Bones used to warp the nervous system onto BodyParts3D, with the name of
# the matching BodyParts3D element. The build fits each pair rigidly.
ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth']
FINGERS = ['thumb', 'index finger', 'middle finger', 'ring finger', 'little finger']
TOES = ['big toe', 'second toe', 'third toe', 'fourth toe', 'little toe']
LANDMARKS = {
    'Frontal bone': 'Frontal bone',
    'Occipital bone': 'Occipital bone',
    'Mandible': 'Mandible',
    'Atlas (C1)': 'Atlas',
    'Axis (C2)': 'Axis',
    'Sacrum': 'Sacrum',
}
for i in range(3, 8):
    LANDMARKS[f'Vertebra C{i}'] = f'{ORDINAL[i - 1].capitalize()} cervical vertebra'
for i in range(1, 13):
    LANDMARKS[f'Vertebra T{i}'] = f'{ORDINAL[i - 1].capitalize()} thoracic vertebra'
for i in range(1, 6):
    LANDMARKS[f'Vertebra L{i}'] = f'{ORDINAL[i - 1].capitalize()} lumbar vertebra'
for s, side in (('l', 'Left'), ('r', 'Right')):
    for bone in ('Parietal bone', 'Temporal bone', 'Maxilla', 'Zygomatic bone', 'Clavicle', 'Scapula', 'Humerus',
                 'Radius', 'Ulna', 'Hip bone', 'Femur', 'Patella', 'Tibia', 'Fibula', 'Talus', 'Calcaneus'):
        LANDMARKS[f'{bone}.{s}'] = f'{side} {bone.lower()}'
    for i in range(12):
        LANDMARKS[f'{ORDINAL[i].capitalize()} rib.{s}'] = f'{side} {ORDINAL[i]} rib'
    for i in range(5):
        LANDMARKS[f'{ORDINAL[i].capitalize()} metacarpal bone.{s}'] = f'{side} {ORDINAL[i]} metacarpal bone'
        LANDMARKS[f'{ORDINAL[i].capitalize()} metatarsal bone.{s}'] = f'{side} {ORDINAL[i]} metatarsal bone'
        LANDMARKS[f'Proximal phalanx of {ORDINAL[i]} finger of hand.{s}'] = f'Proximal phalanx of {side.lower()} {FINGERS[i]}'
        LANDMARKS[f'Distal phalanx of {ORDINAL[i]} finger of hand.{s}'] = f'Distal phalanx of {side.lower()} {FINGERS[i]}'
        LANDMARKS[f'Proximal phalanx of {ORDINAL[i]} finger of foot.{s}'] = f'Proximal phalanx of {side.lower()} {TOES[i]}'

landmarks = {}
for zname, bp3d in LANDMARKS.items():
    obj = objects.get(zname)
    if obj is None or obj.type != 'MESH':
        print(f'Landmark {zname} not found, skipped')
        continue
    verts = world_vertices(obj)
    step = max(1, len(verts) // 300)
    landmarks[bp3d] = [[round(v.x, 5), round(v.y, 5), round(v.z, 5)] for v in verts[::step]]
with open(os.path.join(nervous_dir, 'landmarks.json'), 'w') as f:
    json.dump(landmarks, f, separators=(',', ':'))
print(f'Wrote nervous/landmarks.json: {len(landmarks)} bones')


# --- Connective tissue -------------------------------------------------------

# Collections whose meshes make up the connective-tissue layer. Objects ending
# in .j/.g/.i are label anchors, not anatomy.
JOINTS_COLLECTION = '3: Joints'
FASCIA_COLLECTION = '4: Muscular system'
# The muscular collection also holds the fasciae and a few ligaments.
FASCIA_RE = re.compile(
    r'fascia|retinacul|aponeurosis|septum|arch|^Inguinal ligament|^Superficial transverse meta', re.I
)
EXCLUDE_RE = re.compile(
    r'^('
    # Already in the skeletal model (BodyParts3D); the layer shares those meshes.
    r'Intervertebral disc|Nucleus pulposus'
    # Taken from BodyParts3D instead (see build-models.mjs).
    r'|Lateral thyrohyoid ligament|Median thyrohyoid ligament|Median cricothyroid ligament'
    r'|Stylohyoid ligament|Long plantar ligament|Interosseous membrane of|Iliotibial tract'
    r'|Flexor retinaculum of wrist'
    # A child's growth cartilage, fused in this adult model.
    r'|Triradiate cartilage'
    # Muscle parts (tendons stay with the muscles) and a near-duplicate mesh.
    r'|Epicranial aponeurosis|Tensor fasciae|Tendinous arch|Pubic symphysis$'
    r')'
)
MAX_VERTICES = 2500  # larger sheets are decimated; the build simplifies further


depsgraph = bpy.context.evaluated_depsgraph_get()


def evaluated(obj, decimate=False):
    """World-space vertices (mm) and triangles of obj with its modifiers applied."""
    if decimate and len(obj.evaluated_get(depsgraph).data.vertices) > MAX_VERTICES:
        mod = obj.modifiers.new('extract-decimate', 'DECIMATE')
        mod.ratio = MAX_VERTICES / len(obj.evaluated_get(depsgraph).data.vertices)
        depsgraph.update()
    ev = obj.evaluated_get(depsgraph)
    mesh = ev.to_mesh()
    mw = obj.matrix_world
    verts = np.array([tuple(mw @ v.co) for v in mesh.vertices]) * 1000.0
    tris = []
    for poly in mesh.polygons:
        idx = list(poly.vertices)
        tris += [(idx[0], idx[k], idx[k + 1]) for k in range(1, len(idx) - 1)]
    ev.to_mesh_clear()
    if decimate and 'extract-decimate' in obj.modifiers:
        obj.modifiers.remove(obj.modifiers['extract-decimate'])
        depsgraph.update()
    return verts, np.array(tris, dtype=np.int64).reshape(-1, 3)


def read_bp3d(path):
    name, verts = None, []
    with open(path) as f:
        for line in f:
            if line.startswith('v '):
                verts.append([float(t) for t in line.split()[1:4]])
            elif line.startswith('# English name :'):
                name = line.split(':', 1)[1].strip()
    return name, np.array(verts)


FINGER_ORDINAL = {'thumb': 'first', 'index finger': 'second', 'middle finger': 'third',
           'ring finger': 'fourth', 'little finger': 'fifth'}
TOE_ORDINAL = {'big toe': 'first', 'second toe': 'second', 'third toe': 'third',
        'fourth toe': 'fourth', 'little toe': 'fifth'}
CARPALS = {'capitate', 'hamate', 'lunate', 'pisiform', 'scaphoid', 'trapezium', 'trapezoid'}
SPINE = [f'C{i}' for i in range(1, 8)] + [f'T{i}' for i in range(1, 13)] + [f'L{i}' for i in range(1, 6)] + ['S1']
REGION = {'cervical': 'C', 'thoracic': 'T', 'lumbar': 'L'}


def z_anatomy_name(name, file_id):
    """Name of the Z-Anatomy object matching a BodyParts3D bone or cartilage, if any."""
    if file_id == 'FJ3211':  # unnamed in the dataset; sits between T12 and L1
        return 'Intervertebral disc T12-L1'
    m = re.match(r'(Distal|Middle|Proximal) phalanx of (left|right) (.+)$', name)
    if m:
        digit, side = m.group(3), '.l' if m.group(2) == 'left' else '.r'
        if digit in FINGER_ORDINAL:
            return f'{m.group(1)} phalanx of {FINGER_ORDINAL[digit]} finger of hand{side}'
        return f'{m.group(1)} phalanx of {TOE_ORDINAL[digit]} finger of foot{side}'
    m = re.match(r'Navicular bone of (left|right) foot$', name)
    if m:
        return 'Navicular bone' + ('.l' if m.group(1) == 'left' else '.r')
    m = re.match(r'Intervertebral disk of (axis|(\w+) (cervical|thoracic|lumbar) vertebra)$', name)
    if m:
        upper = 'C2' if m.group(1) == 'axis' else f'{REGION[m.group(3)]}{ORDINAL.index(m.group(2)) + 1}'
        return f'Intervertebral disc {upper}-{SPINE[SPINE.index(upper) + 1]}'
    m = re.match(r'(\w+) (cervical|thoracic|lumbar) vertebra$', name)
    if m:
        return f'Vertebra {REGION[m.group(2)]}{ORDINAL.index(m.group(1).lower()) + 1}'
    special = {'Atlas': 'Atlas (C1)', 'Axis': 'Axis (C2)', 'Manubrium': 'Manubrium of sternum',
               'Ethmoid': 'Ethmoid bone'}
    if name in special:
        return special[name]
    side = ''
    m = re.match(r'(Left|Right) (.+)$', name)
    if m:
        side, name = ('.l' if m.group(1) == 'Left' else '.r'), m.group(2)
    m = re.match(r'(\w+) costal cartilage$', name)
    if m:
        return f'Costal cartilage of {m.group(1)} rib{side}'
    if name == 'triquetral':
        return 'Triquetrum bone' + side
    if name in CARPALS:
        return f'{name.capitalize()} bone{side}'
    if name == 'inferior nasal concha':
        return 'Inferior nasal concha bone' + side
    return name[0].upper() + name[1:] + side


def umeyama(src, dst):
    """Similarity transform (s, R, t) minimising |s R src + t - dst|."""
    mu_s, mu_d = src.mean(0), dst.mean(0)
    a, b = src - mu_s, dst - mu_d
    u, d, vt = np.linalg.svd(b.T @ a / len(src))
    e = np.eye(3)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        e[2, 2] = -1
    r = u @ e @ vt
    s = np.trace(np.diag(d) @ e) / a.var(0).sum()
    s = min(max(s, 0.85), 1.15)
    return s, r, mu_d - s * r @ mu_s


def kdtree(points):
    tree = KDTree(len(points))
    for i, p in enumerate(points):
        tree.insert(p, i)
    tree.balance()
    return tree


def subsample(points, n):
    return points if len(points) <= n else points[np.linspace(0, len(points) - 1, n).astype(int)]


def icp(src, dst, transform, symmetric=True, iterations=40):
    """ICP of src onto dst from an initial (s, R, t); returns it refined and the RMS residual in mm."""
    src_s, dst_s = subsample(src, 1500), subsample(dst, 1500)
    dst_tree, (s, r, t) = kdtree(dst_s), transform
    for _ in range(iterations):
        moved = s * src_s @ r.T + t
        fwd = np.array([dst_tree.find(p)[0] for p in moved])
        if symmetric:
            src_tree = kdtree(moved)
            back = np.array([src_s[src_tree.find(p)[1]] for p in dst_s])
            s, r, t = umeyama(np.vstack([src_s, back]), np.vstack([fwd, dst_s]))
        else:
            s, r, t = umeyama(src_s, fwd)
    moved = s * src_s @ r.T + t
    rms = np.sqrt(np.mean([dst_tree.find(p)[2] ** 2 for p in moved]))
    return (s, r, t), rms


SEGMENT_MM = 60  # long bones are registered piecewise, in pieces about this long


def register(src, dst):
    """Registers a Z-Anatomy bone onto its BodyParts3D twin.

    Returns [(Z-Anatomy vertices, transform)] pieces and the worst RMS residual.
    The bones' shapes differ a little, so a long bone is split along its long
    axis and each piece is fitted on its own, starting from the whole-bone fit.
    """
    whole, rms = icp(src, dst, (1.0, np.eye(3), dst.mean(0) - src.mean(0)))
    centred = src - src.mean(0)
    axis = np.linalg.svd(centred, full_matrices=False)[2][0]
    along = centred @ axis
    n = int(np.ceil((along.max() - along.min()) / SEGMENT_MM))
    if n < 2:
        return [(src, whole)], rms
    pieces, worst = [], 0
    edges = np.linspace(along.min(), along.max(), n + 1)
    for lo, hi in zip(edges[:-1], edges[1:]):
        core = src[(along >= lo) & (along <= hi)]
        margin = SEGMENT_MM * 0.3
        fit = src[(along >= lo - margin) & (along <= hi + margin)]
        s, r, t = whole
        moved = s * fit @ r.T + t
        lo_b, hi_b = moved.min(0) - 15, moved.max(0) + 15
        near = dst[np.all((dst >= lo_b) & (dst <= hi_b), axis=1)]
        if len(near) < 50:
            near = dst
        transform, piece_rms = icp(fit, near, whole, symmetric=False, iterations=25)
        pieces.append((core, transform))
        worst = max(worst, piece_rms)
    return pieces, worst


# Register every Z-Anatomy bone/cartilage that has a BodyParts3D twin.
references = []  # (Z-Anatomy vertices in mm, transform)
bp3d_files = [f'FJ{i}' for i in range(3152, 3396)] + ['FJ2440', 'FJ2775', 'FJ2792', 'FJ2808']
for file_id in bp3d_files:
    path = os.path.join(bp3d_dir, f'{file_id}.obj')
    if not os.path.exists(path):
        continue
    name, bp3d_verts = read_bp3d(path)
    obj = bpy.data.objects.get(z_anatomy_name(name, file_id))
    if obj is None or obj.type != 'MESH':
        continue
    z_verts, _ = evaluated(obj)
    pieces, rms = register(z_verts, bp3d_verts)
    if rms > 3:
        print(f'  {name}: registration residual {rms:.1f} mm')
    references += [(subsample(v, 1500), t) for v, t in pieces]
print(f'Registered Z-Anatomy bones onto BodyParts3D in {len(references)} pieces')

ref_points = np.vstack([v for v, _ in references])
ref_owner = np.concatenate([np.full(len(v), i) for i, (v, _) in enumerate(references)])
ref_tree = kdtree(ref_points)


def to_bp3d(verts):
    """Moves Z-Anatomy vertices (mm) with the registered bones nearest to each."""
    out = np.empty_like(verts)
    for i, p in enumerate(verts):
        nearest = {}
        for _, j, d in ref_tree.find_n(p, 48):
            nearest.setdefault(int(ref_owner[j]), d)
        d0 = min(nearest.values())
        bones = sorted((d, b) for b, d in nearest.items() if d <= d0 + 20)[:3]
        w = np.array([1 / (d + 3) ** 2 for d, _ in bones])
        w /= w.sum()
        out[i] = sum(wk * (s * r @ p + t) for wk, (_, b) in zip(w, bones) for s, r, t in [references[b][1]])
    return out


def selected_objects():
    def walk(coll, fascia):
        for obj in coll.objects:
            if obj.type != 'MESH' or re.search(r'\.[gji]$', obj.name) or EXCLUDE_RE.match(obj.name):
                continue
            if fascia and not FASCIA_RE.search(obj.name):
                continue
            yield obj
        for child in coll.children:
            yield from walk(child, fascia)
    root = bpy.context.scene.collection.children
    yield from walk(root[JOINTS_COLLECTION], False)
    yield from walk(root[FASCIA_COLLECTION], True)


def display_name(obj_name, centre_x):
    """'Acetabular labrum.l' -> 'Left acetabular labrum'; Z-Anatomy +X is the body's left."""
    base, side = re.match(r'(.+?)(?:\.([lr]))?$', obj_name).groups()
    paired = side or f'{base}.l' in bpy.data.objects or f'{base}.r' in bpy.data.objects
    if not paired:
        return base
    side = side or ('l' if centre_x > 0 else 'r')
    return ('Left ' if side == 'l' else 'Right ') + base[0].lower() + base[1:]


lines = ['# Extracted from Z-Anatomy (https://www.z-anatomy.com), CC BY-SA 4.0,',
         '# and registered onto BodyParts3D (millimetres) by scripts/extract-z-anatomy.py.']
offset, count = 1, 0
for obj in sorted(selected_objects(), key=lambda o: o.name):
    verts, tris = evaluated(obj, decimate=True)
    if not len(tris):
        continue
    verts = to_bp3d(verts)
    lines += [f'o {obj.name}', f'# English name : {display_name(obj.name, verts[:, 0].mean())}']
    lines += [f'v {x:.2f} {y:.2f} {z:.2f}' for x, y, z in verts]
    lines += [f'f {a + offset} {b + offset} {c + offset}' for a, b, c in tris]
    offset += len(verts)
    count += 1
path = os.path.join(out_dir, 'connective-tissue.obj.gz')
with gzip.open(path, 'wt', compresslevel=9, newline='\n') as f:
    f.write('\n'.join(lines) + '\n')
print(f'Wrote connective-tissue.obj.gz: {count} parts, {offset - 1} vertices')
