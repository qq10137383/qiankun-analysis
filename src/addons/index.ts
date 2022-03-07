/**
 * @author Kuitos
 * @since 2020-03-02
 */

import { concat, mergeWith } from 'lodash';
import type { FrameworkLifeCycles, ObjectType } from '../interfaces';

import getRuntimePublicPathAddOn from './runtimePublicPath';
import getEngineFlagAddon from './engineFlag';

// 合并两个生命周期钩子函数
export default function getAddOns<T extends ObjectType>(global: Window, publicPath: string): FrameworkLifeCycles<T> {
  return mergeWith({}, getEngineFlagAddon(global), getRuntimePublicPathAddOn(global, publicPath), (v1, v2) =>
    concat(v1 ?? [], v2 ?? []),
  );
}
