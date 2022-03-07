/**
 * @author Kuitos
 * @since 2020-05-15
 */

import type { FrameworkLifeCycles } from '../interfaces';

// 返回微应用生命周期钩子，增加qiankun标志__INJECTED_PUBLIC_PATH_BY_QIANKUN__
export default function getAddOn(global: Window): FrameworkLifeCycles<any> {
  return {
    async beforeLoad() {
      // eslint-disable-next-line no-param-reassign
      global.__POWERED_BY_QIANKUN__ = true;
    },

    async beforeMount() {
      // eslint-disable-next-line no-param-reassign
      global.__POWERED_BY_QIANKUN__ = true;
    },

    async beforeUnmount() {
      // eslint-disable-next-line no-param-reassign
      delete global.__POWERED_BY_QIANKUN__;
    },
  };
}
