import * as THREE from 'three';

// Stillwater atmosphere constants shared by the TSL fog node, sky and story camera.
export const MOON_DIR = new THREE.Vector3(0.05, 0.20, 0.98).normalize();
export const FOG_TEAL = new THREE.Color(0.05, 0.155, 0.155);
// §2.1/§2.2: the key light of the key art is the sunset afterglow below the horizon, down-channel from the hero
// camera (the plate's coral band sits on +z via sky7_project.py U_CENTRE 0.124 with the dome yaw 2.35).
export const SUNSET_DIR = new THREE.Vector3(0.1, 0.0, 1.0).normalize();
// §2.3: haze above the teal band is mauve-rose, not teal; the clear colour shows through at the far horizon
export const HAZE_MAUVE = new THREE.Color(0.17, 0.10, 0.17);
