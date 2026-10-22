import { Color, Ellipsoid, EllipsoidTerrainProvider, SceneMode, Viewer } from 'cesium';
import { attachZoomControl } from './zoomControl';

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
  // Fine-grained native zoom: smaller wheel steps and less motion after release.
  viewer.scene.screenSpaceCameraController.zoomFactor = 1.0;
  viewer.scene.screenSpaceCameraController.inertiaZoom = 0.2;
  let zoomControl: ReturnType<typeof attachZoomControl>;
  try {
    zoomControl = attachZoomControl(container, value => {
      if (!viewer.isDestroyed()) viewer.scene.screenSpaceCameraController.zoomFactor = value;
    });
  } catch (error) {
    try { if (!viewer.isDestroyed()) viewer.destroy(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Zoom control initialization and Viewer release failed'); }
    throw error;
  }
  return {
    viewer,
    destroy() {
      const errors: unknown[] = [];
      try { zoomControl.destroy(); } catch (error) { errors.push(error); }
      try { if (!viewer.isDestroyed()) viewer.destroy(); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Viewer resource release unconfirmed');
    },
  };
}
