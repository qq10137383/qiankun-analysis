/**
 * @author Kuitos
 * @since 2019-04-11
 */
import type { Freer, Rebuilder, SandBox } from '../interfaces';
import LegacySandbox from './legacy/sandbox';
import { patchAtBootstrapping, patchAtMounting } from './patchers';
import ProxySandbox from './proxySandbox';
import SnapshotSandbox from './snapshotSandbox';

export { css } from './patchers';

/**
 * 生成应用运行时沙箱
 *
 * 沙箱分两个类型：
 * 1. app 环境沙箱
 *  app 环境沙箱是指应用初始化过之后，应用会在什么样的上下文环境运行。每个应用的环境沙箱只会初始化一次，因为子应用只会触发一次 bootstrap 。
 *  子应用在切换时，实际上切换的是 app 环境沙箱。
 * 2. render 沙箱
 *  子应用在 app mount 开始前生成好的的沙箱。每次子应用切换过后，render 沙箱都会重现初始化。
 *
 * 这么设计的目的是为了保证每个子应用切换回来之后，还能运行在应用 bootstrap 之后的环境下。
 *
 * @param appName
 * @param elementGetter
 * @param scopedCSS
 * @param useLooseSandbox
 * @param excludeAssetFilter
 */
export function createSandboxContainer(
  appName: string,
  elementGetter: () => HTMLElement | ShadowRoot,
  scopedCSS: boolean,
  useLooseSandbox?: boolean,
  excludeAssetFilter?: (url: string) => boolean,
) {
  let sandbox: SandBox;
  if (window.Proxy) {
    // 创建基于Proxy的沙箱(新的浏览器)，LegacySandbox沙箱每次只能有一个沙箱处于激活状态，也就是对应于singular类型的微应用
    // ProxySandbox可以同时有多个沙箱，对应于多应用共存的微应用
    sandbox = useLooseSandbox ? new LegacySandbox(appName) : new ProxySandbox(appName);
  } else {
    // 快照沙箱，兼容老的浏览器
    sandbox = new SnapshotSandbox(appName);
  }

  // 启动沙盒时拦截document.createElment方法，拦截script、link、style元素的创建
  // 拦截head、body的appendChild、insertBefore、removeChild等方法
  // 目的是使微应用动态创建的script、link、style应该添加到挂载dom上而不是在主应用中，
  // 卸载应用的时候挂载dom会删除，这些脚本和样式也会一起删除
  // bootstrapp阶段的状态在应用卸载时会被删除，重新mount的时候会被重建
  // some side effect could be be invoked while bootstrapping, such as dynamic stylesheet injection with style-loader, especially during the development phase
  const bootstrappingFreers = patchAtBootstrapping(appName, elementGetter, sandbox, scopedCSS, excludeAssetFilter);
  // mounting freers are one-off and should be re-init at every mounting time
  // mount阶段的状态在应用卸载时会被删除，但是重新mount不会被重建，需要重新初始化
  let mountingFreers: Freer[] = [];

  let sideEffectsRebuilders: Rebuilder[] = [];

  return {
    instance: sandbox,

    /**
     * 沙箱被 mount
     * 可能是从 bootstrap 状态进入的 mount
     * 也可能是从 unmount 之后再次唤醒进入 mount
     */
    async mount() {
      /* ------------------------------------------ 因为有上下文依赖（window），以下代码执行顺序不能变 ------------------------------------------ */

      /* ------------------------------------------ 1. 启动/恢复 沙箱------------------------------------------ */
      sandbox.active();

      // 需要还原的Bootstrap阶段的状态
      const sideEffectsRebuildersAtBootstrapping = sideEffectsRebuilders.slice(0, bootstrappingFreers.length);
      // 需要还原的Mount阶段的状态
      const sideEffectsRebuildersAtMounting = sideEffectsRebuilders.slice(bootstrappingFreers.length);

      // must rebuild the side effects which added at bootstrapping firstly to recovery to nature state
      // 还原Bootstrap阶段的状态
      if (sideEffectsRebuildersAtBootstrapping.length) {
        sideEffectsRebuildersAtBootstrapping.forEach((rebuild) => rebuild());
      }

      /* ------------------------------------------ 2. 开启全局变量补丁 ------------------------------------------*/
      // render 沙箱启动时开始劫持各类全局监听，尽量不要在应用初始化阶段有 事件监听/定时器 等副作用
      // mount阶段拦截定时器、事件监听
      mountingFreers = patchAtMounting(appName, elementGetter, sandbox, scopedCSS, excludeAssetFilter);

      /* ------------------------------------------ 3. 重置一些初始化时的副作用 ------------------------------------------*/
      // 存在 rebuilder 则表明有些副作用需要重建
      if (sideEffectsRebuildersAtMounting.length) {
        sideEffectsRebuildersAtMounting.forEach((rebuild) => rebuild());
      }

      // clean up rebuilders
      sideEffectsRebuilders = [];
    },

    /**
     * 恢复 global 状态，使其能回到应用加载之前的状态
     */
    async unmount() {
      // record the rebuilders of window side effects (event listeners or timers)
      // note that the frees of mounting phase are one-off as it will be re-init at next mounting
      // free方法会恢复状态，返回的rebuild方法会在下次mount的时候重建状态
      sideEffectsRebuilders = [...bootstrappingFreers, ...mountingFreers].map((free) => free());
      
      sandbox.inactive();
    },
  };
}
