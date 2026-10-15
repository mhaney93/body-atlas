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
# winding flipped back.
import os
import re
import sys

import bpy

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


def safe(name):
    return name.replace('/', '_').replace(':', '')


for group, objs in groups:
    folder = os.path.join(out_dir, safe(group))
    os.makedirs(folder, exist_ok=True)
    count = 0
    for obj in objs:
        if obj.type != 'MESH' or not obj.data.polygons:
            continue
        evaluated = obj.evaluated_get(depsgraph)
        m = evaluated.matrix_world
        flip = m.determinant() < 0
        mesh = evaluated.to_mesh()
        lines = [
            '# Exported from Z-Anatomy (https://www.z-anatomy.com), CC BY-SA 4.0',
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
    print(f'{group}: wrote {count} meshes to {folder}', flush=True)
