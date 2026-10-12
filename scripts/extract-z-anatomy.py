# Extracts parts that BodyParts3D lacks from the Z-Anatomy Blender template
# into data-sources/z-anatomy/ (licenses: README "Anatomy model"), which
# scripts/build-models.mjs then aligns onto the BodyParts3D model.
#
# Usage (Blender 4.x; see README "Rebuilding the models"):
#   blender -b --factory-startup --disable-autoexec Startup.blend \
#     --python scripts/extract-z-anatomy.py -- data-sources/z-anatomy
#
# Everything is written in Z-Anatomy world space (metres, +Z up, -Y anterior).
#
# - Bones (coccyx.obj, ossicles/): each OBJ header records an anchor point on the bone it
#   attaches to, computed the same way the build script computes it on the
#   BodyParts3D mesh, so the build can translate the part into place.
# - Nervous system (nervous/): brain regions and other meshes as OBJ files,
#   the nerves (Bezier curves in Z-Anatomy) sampled into polylines with a
#   radius per point (nerves.json), and sample points of the bones the build
#   uses as landmarks to warp it all onto the BodyParts3D skeleton
#   (landmarks.json).
#
# Meshes are read as stored, except those with modifiers (the spinal cord is
# a short segment arrayed and bent along a curve), which are evaluated first.
import json
import os
import sys

import bpy
from mathutils.geometry import interpolate_bezier

# Z-Anatomy object -> (output file, display name, anchor object, anchor rule)
PARTS = {
    'Coccyx': ('coccyx.obj', 'Coccyx', 'Sacrum', 'lowest'),
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
