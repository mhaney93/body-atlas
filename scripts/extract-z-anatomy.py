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

out_dir = sys.argv[sys.argv.index('--') + 1]
os.makedirs(out_dir, exist_ok=True)


def world_vertices(obj):
    return [obj.matrix_world @ v.co for v in obj.data.vertices]


def anchor(obj, rule):
    # 'lowest': centroid of the lowest 2% of vertices (e.g. the sacrum's apex).
    verts = sorted(world_vertices(obj), key=lambda v: v.z)
    if rule != 'lowest':
        raise ValueError(rule)
    n = max(1, len(verts) // 50)
    return [sum(v[i] for v in verts[:n]) / n for i in range(3)]


for name, (filename, label, anchor_name, rule) in PARTS.items():
    obj = bpy.data.objects[name]
    a = anchor(bpy.data.objects[anchor_name], rule)
    mesh = obj.data
    lines = [
        '# Extracted from Z-Anatomy (https://www.z-anatomy.com), CC BY-SA 4.0',
        f'# English name : {label}',
        f'# Anchor : {anchor_name} {rule} {a[0]:.6f} {a[1]:.6f} {a[2]:.6f}',
    ]
    lines += [f'v {v.x:.6f} {v.y:.6f} {v.z:.6f}' for v in world_vertices(obj)]
    for poly in mesh.polygons:
        idx = [i + 1 for i in poly.vertices]
        for k in range(1, len(idx) - 1):
            lines.append(f'f {idx[0]} {idx[k]} {idx[k + 1]}')
    with open(os.path.join(out_dir, filename), 'w') as f:
        f.write('\n'.join(lines) + '\n')
    print(f'Wrote {filename}: {len(mesh.vertices)} vertices')
