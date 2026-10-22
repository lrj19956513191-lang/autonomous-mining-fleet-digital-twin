import { Color, Ellipsoid, EllipsoidTerrainProvider, SceneMode, Viewer } from 'cesium';

export type ViewerHandle = { viewer: Viewer; destroy(): void };

export function createViewer(container: HTMLElement): ViewerHandle {
  const viewer = new Viewer(container, {
    ellipsoid: Ellipsoid.WGS84,
    terrainProvider: new EllipsoidTerrainProvider({ ellipsoid: Ellipsoid.WGS84 }),
    sceneMode: SceneMode.SCENE3D,
    scene3DOnly: true,
    baseLayerPicker: false,
    baseLayer: false,
    geocoder: false,
    timeline: false,
    animation: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
  });
  viewer.scene.globe.baseColor = Color.DARKSLATEGRAY;
  return {
    viewer,
    destroy() {
      if (!viewer.isDestroyed()) viewer.destroy();
    },
  };
}
