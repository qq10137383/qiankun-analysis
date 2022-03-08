/**
 * @author Kuitos
 * @since 2020-10-13
 */

import type { Freer } from '../../../interfaces';
import { getCurrentRunningSandboxProxy } from '../../common';
import type { ContainerConfig } from './common';
import {
  isHijackingTag,
  patchHTMLDynamicAppendPrototypeFunctions,
  rawHeadAppendChild,
  rebuildCSSRules,
  recordStyledComponentsCSSRules,
} from './common';

const rawDocumentCreateElement = Document.prototype.createElement;
const proxyAttachContainerConfigMap = new WeakMap<WindowProxy, ContainerConfig>();

const elementAttachContainerConfigMap = new WeakMap<HTMLElement, ContainerConfig>();
// 拦截document.createElement方法，拦截script、link、style元素的创建
function patchDocumentCreateElement() {
  if (Document.prototype.createElement === rawDocumentCreateElement) {
    Document.prototype.createElement = function createElement<K extends keyof HTMLElementTagNameMap>(
      this: Document,
      tagName: K,
      options?: ElementCreationOptions,
    ): HTMLElement {
      const element = rawDocumentCreateElement.call(this, tagName, options);
      if (isHijackingTag(tagName)) {
        const currentRunningSandboxProxy = getCurrentRunningSandboxProxy();
        if (currentRunningSandboxProxy) {
          const proxyContainerConfig = proxyAttachContainerConfigMap.get(currentRunningSandboxProxy);
          if (proxyContainerConfig) {
            elementAttachContainerConfigMap.set(element, proxyContainerConfig);
          }
        }
      }

      return element;
    };
  }

  return function unpatch() {
    Document.prototype.createElement = rawDocumentCreateElement;
  };
}

let bootstrappingPatchCount = 0;
let mountingPatchCount = 0;

export function patchStrictSandbox(
  appName: string,
  appWrapperGetter: () => HTMLElement | ShadowRoot,
  proxy: Window,
  mounting = true,
  scopedCSS = false,
  excludeAssetFilter?: CallableFunction,
): Freer {
  // 初始化沙盒对应的挂载元素配置
  let containerConfig = proxyAttachContainerConfigMap.get(proxy);
  if (!containerConfig) {
    containerConfig = {
      appName,
      proxy,
      appWrapperGetter,
      dynamicStyleSheetElements: [],
      strictGlobal: true,
      excludeAssetFilter,
      scopedCSS,
    };
    proxyAttachContainerConfigMap.set(proxy, containerConfig);
  }
  // all dynamic style sheets are stored in proxy container
  const { dynamicStyleSheetElements } = containerConfig;

  // 拦截document.createElement方法
  const unpatchDocumentCreate = patchDocumentCreateElement();

  // 拦截head、body的appendChild、insertBefore、removeChild等方法，对于微应用中动态增加的
  // script、link、style需要加在挂载dom里面，而不是在主应用中，卸载应用的时候挂载dom会删除，
  // 这些脚本和样式也会一起删除
  const unpatchDynamicAppendPrototypeFunctions = patchHTMLDynamicAppendPrototypeFunctions(
    (element) => elementAttachContainerConfigMap.has(element),
    (element) => elementAttachContainerConfigMap.get(element)!,
  );

  if (!mounting) bootstrappingPatchCount++;
  if (mounting) mountingPatchCount++;

  return function free() {
    // bootstrap patch just called once but its freer will be called multiple times
    if (!mounting && bootstrappingPatchCount !== 0) bootstrappingPatchCount--;
    if (mounting) mountingPatchCount--;

    const allMicroAppUnmounted = mountingPatchCount === 0 && bootstrappingPatchCount === 0;
    // release the overwrite prototype after all the micro apps unmounted
    if (allMicroAppUnmounted) {
      // 还原hook的dom方法
      unpatchDynamicAppendPrototypeFunctions();
      unpatchDocumentCreate();
    }

    recordStyledComponentsCSSRules(dynamicStyleSheetElements);

    // As now the sub app content all wrapped with a special id container,
    // the dynamic style sheet would be removed automatically while unmoutting
    return function rebuild() {
      rebuildCSSRules(dynamicStyleSheetElements, (stylesheetElement) => {
        const appWrapper = appWrapperGetter();
        if (!appWrapper.contains(stylesheetElement)) {
          rawHeadAppendChild.call(appWrapper, stylesheetElement);
          return true;
        }

        return false;
      });
    };
  };
}
