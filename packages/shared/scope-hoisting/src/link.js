// @flow

import type {
  Asset,
  Bundle,
  BundleGraph,
  PluginOptions,
  Symbol,
} from '@parcel/types';
import type {ExternalModule, ExternalBundle} from './types';

import nullthrows from 'nullthrows';
import invariant from 'assert';
import {relative} from 'path';
import template from '@babel/template';
import * as t from '@babel/types';
import traverse from '@babel/traverse';
import treeShake from './shake';
import {getName, getIdentifier} from './utils';
import OutputFormats from './formats/index.js';

const ESMODULE_TEMPLATE = template(`$parcel$defineInteropFlag(EXPORTS);`);
const DEFAULT_INTEROP_TEMPLATE = template(
  'var NAME = $parcel$interopDefault(MODULE)',
);
const THROW_TEMPLATE = template('$parcel$missingModule(MODULE)');

function assertString(v): string {
  invariant(typeof v === 'string');
  return v;
}

export default function link({
  bundle,
  bundleGraph,
  ast,
  options,
}: {|
  bundle: Bundle,
  bundleGraph: BundleGraph,
  ast: any,
  options: PluginOptions,
|}) {
  let format = OutputFormats[bundle.env.outputFormat];
  let replacements: Map<Symbol, Symbol> = new Map();
  let imports: Map<Symbol, ?[Asset, Symbol]> = new Map();
  let assets: Map<string, Asset> = new Map();
  let exportsMap: Map<Symbol, Asset> = new Map();

  let importedFiles = new Map<string, ExternalModule | ExternalBundle>();
  let referencedAssets = new Set();

  // If building a library, the target is actually another bundler rather
  // than the final output that could be loaded in a browser. So, loader
  // runtimes are excluded, and instead we add imports into the entry bundle
  // of each bundle group pointing at the sibling bundles. These can be
  // picked up by another bundler later at which point runtimes will be added.
  if (bundle.env.isLibrary) {
    let bundles = bundleGraph.getSiblingBundles(bundle);
    for (let b of bundles) {
      importedFiles.set(nullthrows(b.filePath), {
        bundle: b,
        assets: new Set(),
      });
    }
  }

  // Build a mapping of all imported identifiers to replace.
  bundle.traverseAssets(asset => {
    assets.set(assertString(asset.meta.id), asset);
    exportsMap.set(assertString(asset.meta.exportsIdentifier), asset);

    for (let dep of bundleGraph.getDependencies(asset)) {
      let resolved = bundleGraph.getDependencyResolution(dep);

      // If the dependency was deferred, the `...$import$..` identifier needs to be removed.
      // If the dependency was excluded, it will be replaced by the output format at the very end.
      if (resolved || dep.isDeferred) {
        for (let [imported, local] of dep.symbols) {
          imports.set(local, resolved ? [resolved, imported] : null);
        }
      }
    }

    if (bundleGraph.isAssetReferencedByAssetType(asset, 'js')) {
      referencedAssets.add(asset);
    }
  });

  function resolveSymbol(inputAsset, inputSymbol) {
    let {asset, exportSymbol, symbol} = bundleGraph.resolveSymbol(
      inputAsset,
      inputSymbol,
    );
    let identifier = symbol;

    // If this is a wildcard import, resolve to the exports object.
    if (asset && exportSymbol === '*') {
      identifier = assertString(asset.meta.exportsIdentifier);
    }

    if (replacements && identifier && replacements.has(identifier)) {
      identifier = replacements.get(identifier);
    }

    return {asset: asset, symbol: exportSymbol, identifier};
  }

  // path is an Identifier that directly imports originalName from originalModule
  function replaceExportNode(originalModule, originalName, path) {
    let {asset: mod, symbol, identifier} = resolveSymbol(
      originalModule,
      originalName,
    );
    let node;

    if (identifier) {
      node = findSymbol(path, identifier);
    }

    // If the module is not in this bundle, create a `require` call for it.
    if (!node && (!mod.meta.id || !assets.has(assertString(mod.meta.id)))) {
      node = addBundleImport(originalModule, path);
      return node ? interop(originalModule, symbol, path, node) : null;
    }

    // If this is an ES6 module, throw an error if we cannot resolve the module
    if (!node && !mod.meta.isCommonJS && mod.meta.isES6Module) {
      let relativePath = relative(options.inputFS.cwd(), mod.filePath);
      throw new Error(`${relativePath} does not export '${symbol}'`);
    }

    // If it is CommonJS, look for an exports object.
    if (!node && mod.meta.isCommonJS) {
      node = findSymbol(path, assertString(mod.meta.exportsIdentifier));
      if (!node) {
        return null;
      }

      return interop(mod, symbol, path, node);
    }

    return node;
  }

  function findSymbol(path, symbol) {
    if (symbol && replacements.has(symbol)) {
      symbol = replacements.get(symbol);
    }

    // if the symbol is in the scope there is no need to remap it
    if (path.scope.getProgramParent().hasBinding(symbol)) {
      return t.identifier(symbol);
    }

    return null;
  }

  function interop(mod, originalName, path, node) {
    // Handle interop for default imports of CommonJS modules.
    if (mod.meta.isCommonJS && originalName === 'default') {
      let name = getName(mod, '$interop$default');
      if (!path.scope.getBinding(name)) {
        // Hoist to the nearest path with the same scope as the exports is declared in
        let binding = path.scope.getBinding(mod.meta.exportsIdentifier);
        let parent;
        if (binding) {
          parent = path.findParent(
            p => getScopeBefore(p) === binding.scope && p.isStatement(),
          );
        }

        if (!parent) {
          parent = path.getStatementParent();
        }

        let [decl] = parent.insertBefore(
          DEFAULT_INTEROP_TEMPLATE({
            NAME: t.identifier(name),
            MODULE: node,
          }),
        );
        // FIXME? register new binding `name` and reference `node`, `$parcel$interopDefault`

        if (binding) {
          binding.reference(decl.get('declarations.0.init'));
        }

        getScopeBefore(parent).registerDeclaration(decl);
      }

      return t.identifier(name);
    }

    // if there is a CommonJS export return $id$exports.name
    if (originalName !== '*') {
      return t.memberExpression(node, t.identifier(originalName));
    }

    return node;
  }

  function getScopeBefore(path) {
    return path.isScope() ? path.parentPath.scope : path.scope;
  }

  function isUnusedValue(path) {
    return (
      path.parentPath.isExpressionStatement() ||
      (path.parentPath.isSequenceExpression() &&
        (path.key !== path.container.length - 1 ||
          isUnusedValue(path.parentPath)))
    );
  }

  function addExternalModule(path, dep) {
    // Find an existing import for this specifier, or create a new one.
    let importedFile = importedFiles.get(dep.moduleSpecifier);
    if (!importedFile) {
      importedFile = {
        source: dep.moduleSpecifier,
        specifiers: new Map(),
        isCommonJS: !!dep.meta.isCommonJS,
      };

      importedFiles.set(dep.moduleSpecifier, importedFile);
    }

    let programScope = path.scope.getProgramParent();

    invariant(importedFile.specifiers != null);
    let specifiers = importedFile.specifiers;

    // For each of the imported symbols, add to the list of imported specifiers.
    for (let [imported, symbol] of dep.symbols) {
      // If already imported, just add the already renamed variable to the mapping.
      let renamed = specifiers.get(imported);
      if (renamed) {
        replacements.set(symbol, renamed);
        continue;
      }

      renamed = replacements.get(symbol);
      if (!renamed) {
        // Rename the specifier to something nicer. Try to use the imported
        // name, except for default and namespace imports, and if the name is
        // already in scope.
        renamed = imported;
        if (imported === 'default' || imported === '*') {
          renamed = programScope.generateUid(dep.moduleSpecifier);
        } else if (
          programScope.hasBinding(imported) ||
          programScope.hasReference(imported)
        ) {
          renamed = programScope.generateUid(imported);
        }

        programScope.references[renamed] = true;
        replacements.set(symbol, renamed);
      }

      specifiers.set(imported, renamed);
      let [decl] = programScope.path.unshiftContainer(
        'body',
        t.variableDeclaration('var', [
          t.variableDeclarator(t.identifier(renamed)),
        ]),
      );
      programScope.registerBinding('var', decl.get('declarations.0'));
    }

    return specifiers.get('*');
  }

  function addBundleImport(mod, path) {
    // Find the first bundle containing this asset, and create an import for it if needed.
    // An asset may be duplicated in multiple bundles, so try to find one that matches
    // the current environment if possible and fall back to the first one.
    let bundles = bundleGraph.findBundlesWithAsset(mod);
    let importedBundle =
      bundles.find(b => b.env.context === bundle.env.context) || bundles[0];
    let filePath = nullthrows(importedBundle.filePath);
    let imported = importedFiles.get(filePath);
    if (!imported) {
      imported = {
        bundle: importedBundle,
        assets: new Set(),
      };
      importedFiles.set(filePath, imported);
    }

    // If not unused, add the asset to the list of specifiers to import.
    if (!isUnusedValue(path) && mod.meta.exportsIdentifier) {
      invariant(imported.assets != null);
      imported.assets.add(mod);

      let program = path.scope.getProgramParent().path;
      let [decl] = program.unshiftContainer('body', [
        t.variableDeclaration('var', [
          t.variableDeclarator(t.identifier(mod.meta.exportsIdentifier)),
        ]),
      ]);
      program.scope.registerBinding('var', decl.get('declarations.0'));

      return t.identifier(mod.meta.exportsIdentifier);
    }
  }

  traverse(ast, {
    CallExpression(path) {
      let {arguments: args, callee} = path.node;
      if (!t.isIdentifier(callee)) {
        return;
      }

      // each require('module') call gets replaced with $parcel$require('id', 'module')
      if (callee.name === '$parcel$require') {
        let [id, source] = args;
        if (
          args.length !== 2 ||
          !t.isStringLiteral(id) ||
          !t.isStringLiteral(source)
        ) {
          throw new Error(
            'invariant: invalid signature, expected: $parcel$require(string, string)',
          );
        }

        let asset = nullthrows(assets.get(id.value));
        let dep = nullthrows(
          bundleGraph
            .getDependencies(asset)
            .find(dep => dep.moduleSpecifier === source.value),
        );

        let mod = bundleGraph.getDependencyResolution(dep);
        let node;

        if (!mod) {
          if (dep.isOptional) {
            path.replaceWith(
              THROW_TEMPLATE({MODULE: t.stringLiteral(source.value)}),
            );
          } else if (dep.isWeak && dep.isDeferred) {
            path.remove();
          } else {
            let name = addExternalModule(path, dep);
            if (isUnusedValue(path) || !name) {
              path.remove();
            } else {
              path.replaceWith(t.identifier(name));
              // FIXME reference `name`
            }
          }
        } else {
          if (mod.meta.id && assets.get(assertString(mod.meta.id))) {
            // Replace with nothing if the require call's result is not used.
            if (!isUnusedValue(path)) {
              let name = assertString(mod.meta.exportsIdentifier);
              node = t.identifier(replacements.get(name) || name);

              // Insert __esModule interop flag if the required module is an ES6 module with a default export.
              // This ensures that code generated by Babel and other tools works properly.
              if (
                asset.meta.isCommonJS &&
                mod.meta.isES6Module &&
                mod.symbols.has('default')
              ) {
                let binding = path.scope.getBinding(name);
                if (binding && !binding.path.getData('hasESModuleFlag')) {
                  if (binding.path.node.init) {
                    binding.path
                      .getStatementParent()
                      .insertAfter(
                        ESMODULE_TEMPLATE({EXPORTS: t.identifier(name)}),
                      );
                    // FIXME reference `name`, `$parcel$defineInteropFlag`
                  }

                  for (let path of binding.constantViolations) {
                    path.insertAfter(
                      ESMODULE_TEMPLATE({EXPORTS: t.identifier(name)}),
                    );
                    // FIXME reference `name`, `$parcel$defineInteropFlag`
                  }

                  binding.path.setData('hasESModuleFlag', true);
                }
              }
            }

            // We need to wrap the module in a function when a require
            // call happens inside a non top-level scope, e.g. in a
            // function, if statement, or conditional expression.
            if (mod.meta.shouldWrap) {
              let call = t.callExpression(getIdentifier(mod, 'init'), []);
              node = node ? t.sequenceExpression([call, node]) : call;
            }

            path.replaceWith(node);
            // FIXME reference node = (`init`, `id`)
            return;
          } else if (mod.type === 'js') {
            node = nullthrows(addBundleImport(mod, path));
            path.replaceWith(node);
            // FIXME reference `node`
            return;
          }

          path.remove();
        }
      } else if (callee.name === '$parcel$require$resolve') {
        let [id, source] = args;
        if (
          args.length !== 2 ||
          !t.isStringLiteral(id) ||
          !t.isStringLiteral(source)
        ) {
          throw new Error(
            'invariant: invalid signature, expected: $parcel$require$resolve(string, string)',
          );
        }

        let mapped = nullthrows(assets.get(id.value));
        let dep = nullthrows(
          bundleGraph
            .getDependencies(mapped)
            .find(dep => dep.moduleSpecifier === source.value),
        );
        let mod = nullthrows(bundleGraph.getDependencyResolution(dep));
        path.replaceWith(t.stringLiteral(mod.id));
      }
    },
    VariableDeclarator: {
      exit(path) {
        // Replace references to declarations like `var x = require('x')`
        // with the final export identifier instead.
        // This allows us to potentially replace accesses to e.g. `x.foo` with
        // a variable like `$id$export$foo` later, avoiding the exports object altogether.
        let {id, init} = path.node;
        if (!t.isIdentifier(init)) {
          return;
        }

        let module = exportsMap.get(init.name);
        if (!module) {
          return;
        }

        let isGlobal = path.scope == path.scope.getProgramParent();

        // Replace patterns like `var {x} = require('y')` with e.g. `$id$export$x`.
        if (t.isObjectPattern(id)) {
          for (let p of path.get('id.properties')) {
            let {computed, key, value} = p.node;
            if (computed || !t.isIdentifier(key) || !t.isIdentifier(value)) {
              continue;
            }

            let {identifier} = resolveSymbol(module, key.name);
            if (identifier) {
              replace(value.name, identifier, p);
              if (isGlobal) {
                replacements.set(value.name, identifier);
              }
            }
          }

          if (id.properties.length === 0) {
            // TODO unregister old
            path.remove();
          }
        } else if (t.isIdentifier(id)) {
          replace(id.name, init.name, path);
          if (isGlobal) {
            replacements.set(id.name, init.name);
          }
        }

        function replace(id, init, path) {
          let binding = path.scope.getBinding(id);
          if (!binding.constant) {
            return;
          }

          for (let ref of binding.referencePaths) {
            // TODO unregister old
            ref.replaceWith(t.identifier(init));
            // FIXME reference `init`
          }

          // TODO unregister old
          path.remove();
        }
      },
    },
    MemberExpression: {
      exit(path) {
        if (!path.isReferenced()) {
          return;
        }

        let {object, property, computed} = path.node;
        if (
          !(
            t.isIdentifier(object) &&
            ((t.isIdentifier(property) && !computed) ||
              t.isStringLiteral(property))
          )
        ) {
          return;
        }

        let module = exportsMap.get(object.name);
        if (!module) {
          return;
        }

        // If it's a $id$exports.name expression.
        let name = t.isIdentifier(property) ? property.name : property.value;
        let {identifier} = resolveSymbol(module, name);

        // Check if $id$export$name exists and if so, replace the node by it.
        if (identifier) {
          // FIXME unregister `object`
          path.replaceWith(t.identifier(identifier));
          // FIXME register `identifier`
        }
      },
    },
    ReferencedIdentifier(path) {
      let {name} = path.node;
      if (typeof name !== 'string') {
        return;
      }

      if (imports.has(name)) {
        let node;
        let imported = imports.get(name);
        if (!imported) {
          // import was deferred
          node = t.objectExpression([]);
        } else {
          let [asset, symbol] = imported;
          node = replaceExportNode(asset, symbol, path);

          // If the export does not exist, replace with an empty object.
          if (!node) {
            node = t.objectExpression([]);
          }
        }

        // FIXME unreference `name`
        path.replaceWith(node);
        if (t.isIdentifier(node)) {
          // FIXME reference node.name
        }
      } else if (replacements.has(name)) {
        // FIXME unreference `name`
        path.node.name = replacements.get(name);
        // FIXME reference replacement
      } else if (exportsMap.has(name) && !path.scope.hasBinding(name)) {
        // If it's an undefined $id$exports identifier.
        path.replaceWith(t.objectExpression([]));
      }
    },
    Program: {
      exit(path) {
        // Recrawl to get all bindings.
        path.scope.crawl();

        // Insert imports for external bundles
        for (let file of importedFiles.values()) {
          if (file.bundle) {
            format.generateBundleImports(
              bundle,
              file.bundle,
              file.assets,
              path,
            );
          } else {
            format.generateExternalImport(bundle, file, path);
          }
        }

        // Generate exports
        let exported = format.generateExports(
          bundleGraph,
          bundle,
          referencedAssets,
          path,
          replacements,
          options,
        );

        treeShake(path.scope, exported);
        // path.stop(); // related to the last check in ReferencedIdentifier visitor
      },
    },
  });

  return ast;
}
