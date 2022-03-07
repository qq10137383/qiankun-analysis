/**
 * @author Kuitos
 * @since 2019-04-11
 */
import type { SandBox } from '../../interfaces';
import { SandBoxType } from '../../interfaces';
import { getTargetValue } from '../common';

function isPropConfigurable(target: typeof window, prop: PropertyKey) {
  const descriptor = Object.getOwnPropertyDescriptor(target, prop);
  return descriptor ? descriptor.configurable : true;
}

function setWindowProp(prop: PropertyKey, value: any, toDelete?: boolean) {
  if (value === undefined && toDelete) {
    delete (window as any)[prop];
  } else if (isPropConfigurable(window, prop) && typeof prop !== 'symbol') {
    Object.defineProperty(window, prop, { writable: true, configurable: true });
    (window as any)[prop] = value;
  }
}

/**
 * 基于 Proxy 实现的沙箱
 * TODO: 为了兼容性 singular 模式下依旧使用该沙箱，等新沙箱稳定之后再切换
 * 这个沙箱将新增或修改的值写入到了原始window对象，并用几个变量还记录新增修改的值
 * 在沙箱激活时恢复到设置状态，反激活时重置到原始状态，所以这个沙箱每次只能有一个是激活状态
 */
export default class SingularProxySandbox implements SandBox {
  /** 沙箱期间新增的全局变量 */
  private addedPropsMapInSandbox = new Map<PropertyKey, any>();

  /** 沙箱期间更新的全局变量 */
  private modifiedPropsOriginalValueMapInSandbox = new Map<PropertyKey, any>();

  /** 持续记录更新的(新增和修改的)全局变量的 map，用于在任意时刻做 snapshot */
  private currentUpdatedPropsValueMap = new Map<PropertyKey, any>();

  name: string;

  proxy: WindowProxy;

  type: SandBoxType;

  sandboxRunning = true;

  latestSetProp: PropertyKey | null = null;

  active() {
    // 沙箱激活时恢复之前设置的值
    if (!this.sandboxRunning) {
      this.currentUpdatedPropsValueMap.forEach((v, p) => setWindowProp(p, v));
    }

    this.sandboxRunning = true;
  }

  inactive() {
    if (process.env.NODE_ENV === 'development') {
      console.info(`[qiankun:sandbox] ${this.name} modified global properties restore...`, [
        ...this.addedPropsMapInSandbox.keys(),
        ...this.modifiedPropsOriginalValueMapInSandbox.keys(),
      ]);
    }

    // renderSandboxSnapshot = snapshot(currentUpdatedPropsValueMapForSnapshot);
    // restore global props to initial snapshot
    // 沙箱反激活时恢复更新的值
    this.modifiedPropsOriginalValueMapInSandbox.forEach((v, p) => setWindowProp(p, v));
    // 删除新增的属性
    this.addedPropsMapInSandbox.forEach((_, p) => setWindowProp(p, undefined, true));

    this.sandboxRunning = false;
  }

  constructor(name: string) {
    this.name = name;
    this.type = SandBoxType.LegacyProxy;
    const { addedPropsMapInSandbox, modifiedPropsOriginalValueMapInSandbox, currentUpdatedPropsValueMap } = this;

    const rawWindow = window;
    const fakeWindow = Object.create(null) as Window;

    // 设置属性值，并记录变更记录
    const setTrap = (p: PropertyKey, value: any, originalValue: any, sync2Window = true) => {
      if (this.sandboxRunning) {
        // 原始window中没有这个值，记录到新增列表中，在沙盒关闭时恢复
        if (!rawWindow.hasOwnProperty(p)) {
          addedPropsMapInSandbox.set(p, value);
        } else if (!modifiedPropsOriginalValueMapInSandbox.has(p)) {
          // 如果当前 window 对象存在该属性，且 record map 中未记录过，则记录该属性初始值
          modifiedPropsOriginalValueMapInSandbox.set(p, originalValue);
        }

        // 无论是新增还是修改都需要记录在此列表中，用来取当前快照值
        currentUpdatedPropsValueMap.set(p, value);

        if (sync2Window) {
          // 必须重新设置 window 对象保证下次 get 时能拿到已更新的数据
          (rawWindow as any)[p] = value;
        }

        this.latestSetProp = p;

        return true;
      }

      if (process.env.NODE_ENV === 'development') {
        console.warn(`[qiankun] Set window.${p.toString()} while sandbox destroyed or inactive in ${name}!`);
      }

      // 在 strict-mode 下，Proxy 的 handler.set 返回 false 会抛出 TypeError，在沙箱卸载的情况下应该忽略错误
      return true;
    };

    // 创建window的代理对象
    const proxy = new Proxy(fakeWindow, {
      set: (_: Window, p: PropertyKey, value: any): boolean => {
        const originalValue = (rawWindow as any)[p];
        return setTrap(p, value, originalValue, true);
      },

      get(_: Window, p: PropertyKey): any {
        // avoid who using window.window or window.self to escape the sandbox environment to touch the really window
        // or use window.top to check if an iframe context
        // see https://github.com/eligrey/FileSaver.js/blob/master/src/FileSaver.js#L13
        // 对于顶层窗口，这4个属性就是window本身
        if (p === 'top' || p === 'parent' || p === 'window' || p === 'self') {
          return proxy;
        }

        const value = (rawWindow as any)[p];
        return getTargetValue(rawWindow, value);
      },

      // trap in operator
      // see https://github.com/styled-components/styled-components/blob/master/packages/styled-components/src/constants.js#L12
      has(_: Window, p: string | number | symbol): boolean {
        return p in rawWindow;
      },

      getOwnPropertyDescriptor(_: Window, p: PropertyKey): PropertyDescriptor | undefined {
        const descriptor = Object.getOwnPropertyDescriptor(rawWindow, p);
        // A property cannot be reported as non-configurable, if it does not exists as an own property of the target object
        if (descriptor && !descriptor.configurable) {
          descriptor.configurable = true;
        }
        return descriptor;
      },

      defineProperty(_: Window, p: string | symbol, attributes: PropertyDescriptor): boolean {
        const originalValue = (rawWindow as any)[p];
        const done = Reflect.defineProperty(rawWindow, p, attributes);
        const value = (rawWindow as any)[p];
        setTrap(p, value, originalValue, false);

        return done;
      },
    });

    this.proxy = proxy;
  }
}
