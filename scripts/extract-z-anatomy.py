# Extracts bones that BodyParts3D lacks from the Z-Anatomy Blender template
# (CC BY-SA 4.0) into data-sources/z-anatomy/ as OBJ files, which
# scripts/build-models.mjs then aligns onto the BodyParts3D skeleton.
#
# Usage (Blender 4.x; see README "Rebuilding the models"):
#   blender -b --factory-startup --disable-autoexec Startup.blend \
#     --python scripts/extract-z-anatomy.py -- data-sources/z-anatomy
#
# Each OBJ is in Z-Anatomy world space (metres, +Z up, -Y anterior). Its
# header records an anchor point on the bone it attaches to, computed the same
# way the build script computes it on the BodyParts3D mesh, so the build can
# translate the part into place.
import os
import sys

import bpy

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


def extract(parts, directory, source):
    os.makedirs(directory, exist_ok=True)
    for name, (filename, label, anchor_name, rule) in parts.items():
        obj = bpy.data.objects[name]
        a = anchor(bpy.data.objects[anchor_name], rule)
        mesh = obj.data
        lines = [
            f'# Extracted from {source}',
            f'# English name : {label}',
            f'# Anchor : {anchor_name} {rule} {a[0]:.6f} {a[1]:.6f} {a[2]:.6f}',
        ]
        lines += [f'v {v.x:.6f} {v.y:.6f} {v.z:.6f}' for v in world_vertices(obj)]
        for poly in mesh.polygons:
            idx = [i + 1 for i in poly.vertices]
            for k in range(1, len(idx) - 1):
                lines.append(f'f {idx[0]} {idx[k]} {idx[k + 1]}')
        with open(os.path.join(directory, filename), 'w') as f:
            f.write('\n'.join(lines) + '\n')
        print(f'Wrote {filename}: {len(mesh.vertices)} vertices')


extract(PARTS, out_dir, 'Z-Anatomy (https://www.z-anatomy.com), CC BY-SA 4.0')
extract(
    OSSICLES,
    os.path.join(out_dir, OSSICLES_DIR),
    'Z-Anatomy (https://www.z-anatomy.com), adapted from "Anatomy of the Inner Ear" '
    'by the University of Dundee School of Medicine, CC BY-NC-SA 4.0',
)
