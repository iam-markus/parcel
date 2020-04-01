// @flow

import type {Asset, Bundle, BundleGraph, Symbol} from '@parcel/types';
import type {NodePath} from '@babel/traverse';
import type {
  Identifier,
  Program,
  Statement,
  StringLiteral,
  VariableDeclaration,
} from '@babel/types';
import type {ExternalBundle, ExternalModule} from '../types';

import * as t from '@babel/types';
import template from '@babel/template';
import {relativeBundlePath} from '@parcel/utils';
import {
  assertString,
  getName,
  getIdentifier,
  getThrowableDiagnosticForNode,
  isEntry,
  isReferenced,
} from '../utils';

const IMPORT_TEMPLATE = template.statement<
  {|IDENTIFIER: Identifier, ASSET_ID: StringLiteral|},
  VariableDeclaration,
>('var IDENTIFIER = parcelRequire(ASSET_ID);');
const EXPORT_TEMPLATE = template.statement<
  {|IDENTIFIER: Identifier, ASSET_ID: StringLiteral|},
  Statement,
>('parcelRequire.register(ASSET_ID, IDENTIFIER)');
const IMPORTSCRIPTS_TEMPLATE = template.statement<
  {|BUNDLE: StringLiteral|},
  Statement,
>('importScripts(BUNDLE);');

export function generateBundleImports(
  from: Bundle,
  {bundle, assets}: ExternalBundle,
) {
  let statements = [];

  if (from.env.isWorker()) {
    statements.push(
      IMPORTSCRIPTS_TEMPLATE({
        BUNDLE: t.stringLiteral(relativeBundlePath(from, bundle)),
      }),
    );
  }

  for (let asset of assets) {
    statements.push(
      IMPORT_TEMPLATE({
        IDENTIFIER: getIdentifier(asset, 'init'),
        ASSET_ID: t.stringLiteral(asset.id),
      }),
    );
  }

  return statements;
}

export function generateExternalImport(_: Bundle, {loc}: ExternalModule) {
  throw getThrowableDiagnosticForNode(
    'External modules are not supported when building for browser',
    loc?.filePath,
    loc,
  );
}

export function generateExports(
  bundleGraph: BundleGraph,
  bundle: Bundle,
  referencedAssets: Set<Asset>,
  path: NodePath<Program>,
) {
  let exported = new Set<Symbol>();
  let statements = [];

  for (let asset of referencedAssets) {
    let exportsId = getName(asset, 'init');
    exported.add(exportsId);

    statements.push(
      EXPORT_TEMPLATE({
        ASSET_ID: t.stringLiteral(asset.id),
        IDENTIFIER: t.identifier(exportsId),
      }),
    );
  }

  let entry = bundle.getMainEntry();
  if (
    entry &&
    (!isEntry(bundle, bundleGraph) || isReferenced(bundle, bundleGraph))
  ) {
    let exportsId = assertString(entry.meta.exportsIdentifier);
    exported.add(exportsId);

    statements.push(
      EXPORT_TEMPLATE({
        ASSET_ID: t.stringLiteral(entry.id),
        IDENTIFIER: t.identifier(assertString(entry.meta.exportsIdentifier)),
      }),
    );
  }

  path.pushContainer('body', statements);
  return exported;
}
