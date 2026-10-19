# Exports collections or chosen objects of the Z-Anatomy Blender template
# (CC BY-SA 4.0) as OBJ files, one per mesh object, for
# scripts/build-models.mjs (the Muscular layer's data-sources/z-anatomy/muscular/).
# Unlike extract-z-anatomy.py it only reads what it exports from the .blend,
# so it needs a few GB of memory rather than the whole scene's ~9 GB.
#
# Usage (Blender 4.x; see README "Rebuilding the models"):
#   blender -b --factory-startup --disable-autoexec --python scripts/export-z-anatomy.py -- \
#     Z-Anatomy/Startup.blend data-sources/z-anatomy \
#     "names:muscular=data-sources/z-anatomy/muscular/objects.txt"
#
# Each selection is a collection name, `objects:<folder>=<regex>` for the
# objects whose names match a regex, or `names:<folder>=<file>` for the
# objects named in a text file, one per line, each with its ".l"/".r"
# variants (loading a whole collection can pull in far more data than its
# objects need).
#
# Output: <out>/<collection or folder>/<object name>.obj in Z-Anatomy world
# space (metres, +Z up, -Y anterior), with modifiers applied and the object
# and parent names in the header. Text labels and other helper objects (no
# faces) are skipped; mirrored objects (negative scale) get their face
# winding flipped back. Bevelled curves (Z-Anatomy draws ducts and nerves
# this way) are written as <object name>.json instead: their splines sampled
# into polylines of [x, y, z, radius] points, in the same space.
import json
import os
import re
import sys

import bpy
from mathutils.geometry import interpolate_bezier

args = sys.argv[sys.argv.index('--') + 1:]
src, out_dir, selections = args[0], args[1], args[2:]
collections = [s for s in selections if not s.startswith(('objects:', 'names:'))]
patterns = dict(s[len('objects:'):].split('=', 1) for s in selections if s.startswith('objects:'))
for s in selections:
    if s.startswith('names:'):
        folder, path = s[len('names:'):].split('=', 1)
        with open(path) as f:
            listed = [re.escape(line.strip()) for line in f if line.strip()]
        patterns[folder] = '^(%s)(\\.[lr])?$' % '|'.join(listed)

with bpy.data.libraries.load(src) as (data_from, data_to):
    data_to.collections = collections
    names = {folder: [n for n in data_from.objects if re.search(rx, n)] for folder, rx in patterns.items()}
    data_to.objects = sorted({n for ns in names.values() for n in ns})

groups = []  # (folder, objects)
for coll in data_to.collections:
    bpy.context.scene.collection.children.link(coll)
    groups.append((coll.name, list(coll.all_objects)))
for folder, ns in names.items():
    objs = [bpy.data.objects[n] for n in ns]
    for obj in objs:
        bpy.context.scene.collection.objects.link(obj)
    groups.append((folder, objs))
depsgraph = bpy.context.evaluated_depsgraph_get()
depsgraph.update()


# Objects Z-Anatomy adapted, or may have adapted, from the University of
# Dundee's "Anatomy of the Inner Ear" (CC BY-NC-SA 4.0), whose files say so.
NON_COMMERCIAL = re.compile(r'^(Cochlea|Vestibule|Tympanic membrane|Auditory tube)\.[lr]$')
NON_COMMERCIAL_SOURCE = ('adapted from "Anatomy of the Inner Ear" by the University of Dundee School of Medicine, '
                         'CC BY-NC-SA 4.0')


def safe(name):
    return name.replace('/', '_').replace(':', '')


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


for group, objs in groups:
    folder = os.path.join(out_dir, safe(group))
    os.makedirs(folder, exist_ok=True)
    count = 0
    for obj in objs:
        if obj.type == 'CURVE' and obj.data.splines:
            with open(os.path.join(folder, safe(obj.name) + '.json'), 'w') as f:
                json.dump({'source': 'Z-Anatomy (https://www.z-anatomy.com), CC BY-SA 4.0', 'name': obj.name,
                           'lines': sample_curve(obj)}, f, separators=(',', ':'))
            count += 1
            continue
        if obj.type != 'MESH' or not obj.data.polygons:
            continue
        evaluated = obj.evaluated_get(depsgraph)
        m = evaluated.matrix_world
        flip = m.determinant() < 0
        mesh = evaluated.to_mesh()
        license = NON_COMMERCIAL_SOURCE if NON_COMMERCIAL.match(obj.name) else 'CC BY-SA 4.0'
        lines = [
            f'# Exported from Z-Anatomy (https://www.z-anatomy.com), {license}',
            f'# Z-Anatomy name : {obj.name}',
            f'# Parent : {obj.parent.name if obj.parent else ""}',
        ]
        lines += ['v %.6f %.6f %.6f' % tuple(m @ v.co) for v in mesh.vertices]
        for poly in mesh.polygons:
            idx = [i + 1 for i in poly.vertices]
            if flip:
                idx.reverse()
            for k in range(1, len(idx) - 1):
                lines.append(f'f {idx[0]} {idx[k]} {idx[k + 1]}')
        with open(os.path.join(folder, safe(obj.name) + '.obj'), 'w') as f:
            f.write('\n'.join(lines) + '\n')
        evaluated.to_mesh_clear()
        count += 1
    print(f'{group}: wrote {count} meshes and curves to {folder}', flush=True)
