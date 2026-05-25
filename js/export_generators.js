(function () {
    "use strict";

    const BROWN_CONRADY_OPTMOD = 20;

    function numberText(value) {
        if (!Number.isFinite(value)) {
            return "0.0";
        }
        return Number(value).toPrecision(12);
    }

    function optparArrayText(context, language = "python") {
        const values = [context.optmod].concat(context.optpar).map(numberText);
        if (language === "c") {
            return `static const double optpar[${values.length}] = {${values.join(", ")}};`;
        }
        if (language === "matlab") {
            return `optpar = [${values.join(", ")}];`;
        }
        return `optpar = [${values.join(", ")}]`;
    }

    function header(context, language, inverseIncluded = false) {
        const note = inverseIncluded ?
            "Includes a numerical image_to_az_el inverse." :
            "Forward az_el_to_image export; invert numerically if image_to_az_el is needed.";
        if (language === "c") {
            return `/* AIDA browser calibrator export. optmod=${context.optmod}, image ${context.width}x${context.height}. ${note} */\n`;
        }
        if (language === "matlab") {
            return `% AIDA browser calibrator export. optmod=${context.optmod}, image ${context.width}x${context.height}. ${note}\n`;
        }
        return `# AIDA browser calibrator export. optmod=${context.optmod}, image ${context.width}x${context.height}. ${note}\n`;
    }

    function pythonMapperCode(context) {
        return `${header(context, "python", true)}import numpy as np
from scipy.optimize import least_squares

${optparArrayText(context, "python")}
optpar = np.array(optpar, dtype=float)
optmod = int(round(optpar[0]))
optpar = optpar[1:]
image_width = ${context.width}
image_height = ${context.height}

def _camera_rot(alpha_deg, beta_deg, gamma_deg):
    a = np.deg2rad(alpha_deg)
    b = np.deg2rad(beta_deg)
    g = np.deg2rad(gamma_deg)
    rot1 = np.array([[np.cos(g), -np.sin(g), 0.0],
                     [np.sin(g),  np.cos(g), 0.0],
                     [0.0,        0.0,       1.0]])
    rot2 = np.array([[ np.cos(a), 0.0, np.sin(a)],
                     [0.0,        1.0, 0.0],
                     [-np.sin(a), 0.0, np.cos(a)]])
    rot3 = np.array([[1.0, 0.0,       0.0],
                     [0.0, np.cos(b), np.sin(b)],
                     [0.0, -np.sin(b), np.cos(b)]])
    return rot2 @ rot3 @ rot1

def az_el_to_image(az_deg, el_deg, optpar=optpar, optmod=optmod,
                   width=image_width, height=image_height):
    az = np.deg2rad(az_deg)
    ze = np.deg2rad(90.0 - el_deg)
    rot = _camera_rot(optpar[2], optpar[3], optpar[4])
    sinze = np.sin(ze)
    es = np.array([sinze * np.sin(az), sinze * np.cos(az), np.cos(ze)])
    s1, s2, s3 = es @ rot
    radial = np.hypot(s1, s2)
    f1, f2, du, dv, radial_alpha = optpar[0], optpar[1], optpar[5], optpar[6], optpar[7]
    if radial <= 1e-12:
        u_norm = 0.5 + du
        v_norm = 0.5 + dv
    elif optmod == 1:
        safe_s3 = s3 if abs(s3) > 1e-12 else 1e-12
        u_norm = f1 * s1 / safe_s3 + 0.5 + du
        v_norm = f2 * s2 / safe_s3 + 0.5 + dv
    elif optmod == 2:
        theta = np.arctan2(radial, s3)
        r = np.sin(radial_alpha * theta)
        u_norm = f1 * s1 / radial * r + 0.5 + du
        v_norm = f2 * s2 / radial * r + 0.5 + dv
    elif optmod == 3:
        theta = np.arctan2(radial, s3)
        safe_s3 = max(s3, 1e-12)
        u_norm = f1 * (1.0 - radial_alpha) * s1 / safe_s3 + f1 * radial_alpha * s1 / radial * theta + 0.5 + du
        v_norm = f2 * (1.0 - radial_alpha) * s2 / safe_s3 + f2 * radial_alpha * s2 / radial * theta + 0.5 + dv
    elif optmod == 4:
        theta = np.arctan2(radial, s3)
        r = abs(theta) ** radial_alpha
        u_norm = f1 * s1 / radial * r + 0.5 + du
        v_norm = f2 * s2 / radial * r + 0.5 + dv
    elif optmod == 5:
        theta = np.arctan2(radial, s3)
        r = np.tan(radial_alpha * theta)
        u_norm = f1 * s1 / radial * r + 0.5 + du
        v_norm = f2 * s2 / radial * r + 0.5 + dv
    elif optmod == 12:
        theta = np.arctan2(radial, s3)
        if radial_alpha > 0:
            r = np.tan(radial_alpha * theta) / radial_alpha
        elif radial_alpha < 0:
            r = np.sin(radial_alpha * theta) / radial_alpha
        else:
            r = abs(theta)
        u_norm = f1 * s1 / radial * r + 0.5 + du
        v_norm = f2 * s2 / radial * r + 0.5 + dv
    elif optmod == ${BROWN_CONRADY_OPTMOD}:
        safe_s3 = s3 if abs(s3) > 1e-12 else 1e-12
        xn = s1 / safe_s3
        yn = s2 / safe_s3
        r2 = xn * xn + yn * yn
        r4 = r2 * r2
        r6 = r4 * r2
        k1 = optpar[7] if len(optpar) > 7 else 0.0
        k2 = optpar[8] if len(optpar) > 8 else 0.0
        k3 = optpar[9] if len(optpar) > 9 else 0.0
        p1 = optpar[10] if len(optpar) > 10 else 0.0
        p2 = optpar[11] if len(optpar) > 11 else 0.0
        radial_distortion = 1.0 + k1 * r2 + k2 * r4 + k3 * r6
        x_distorted = xn * radial_distortion + 2.0 * p1 * xn * yn + p2 * (r2 + 2.0 * xn * xn)
        y_distorted = yn * radial_distortion + p1 * (r2 + 2.0 * yn * yn) + 2.0 * p2 * xn * yn
        u_norm = f1 * x_distorted + 0.5 + du
        v_norm = f2 * y_distorted + 0.5 + dv
    else:
        raise ValueError(f"unsupported optmod {optmod}")
    return np.array([u_norm * width - 1.0, v_norm * height - 1.0])

def image_to_az_el(x, y, optpar=optpar, optmod=optmod,
                   width=image_width, height=image_height):
    target = np.array([x, y], dtype=float)
    def residual(q):
        return az_el_to_image(q[0] % 360.0, q[1], optpar, optmod, width, height) - target
    starts = [np.array([0.0, 90.0]), np.array([0.0, 60.0]), np.array([90.0, 60.0]),
              np.array([180.0, 60.0]), np.array([270.0, 60.0]), np.array([0.0, 25.0]),
              np.array([90.0, 25.0]), np.array([180.0, 25.0]), np.array([270.0, 25.0])]
    best = None
    for start in starts:
        result = least_squares(residual, start, bounds=([-720.0, 0.0], [720.0, 90.0]))
        err = np.linalg.norm(result.fun)
        if best is None or err < best[0]:
            best = (err, result.x)
    return best[1][0] % 360.0, best[1][1]
`;
    }

    function juliaMapperCode(context) {
        return `${header(context, "julia")}${optparArrayText(context, "julia")}
optmod = round(Int, optpar[1])
optpar = optpar[2:end]
image_width = ${context.width}
image_height = ${context.height}

function camera_rot(alpha_deg, beta_deg, gamma_deg)
    a = deg2rad(alpha_deg); b = deg2rad(beta_deg); g = deg2rad(gamma_deg)
    rot1 = [cos(g) -sin(g) 0.0; sin(g) cos(g) 0.0; 0.0 0.0 1.0]
    rot2 = [cos(a) 0.0 sin(a); 0.0 1.0 0.0; -sin(a) 0.0 cos(a)]
    rot3 = [1.0 0.0 0.0; 0.0 cos(b) sin(b); 0.0 -sin(b) cos(b)]
    return rot2 * rot3 * rot1
end

function az_el_to_image(az_deg, el_deg; optpar=optpar, optmod=optmod,
                        width=image_width, height=image_height)
    az = deg2rad(az_deg)
    ze = deg2rad(90.0 - el_deg)
    rot = camera_rot(optpar[3], optpar[4], optpar[5])
    sinze = sin(ze)
    es = [sinze * sin(az), sinze * cos(az), cos(ze)]
    s1, s2, s3 = es' * rot
    radial = hypot(s1, s2)
    f1, f2, du, dv, radial_alpha = optpar[1], optpar[2], optpar[6], optpar[7], optpar[8]
    if radial <= 1e-12
        u_norm = 0.5 + du; v_norm = 0.5 + dv
    elseif optmod == 1
        safe_s3 = abs(s3) > 1e-12 ? s3 : 1e-12
        u_norm = f1 * s1 / safe_s3 + 0.5 + du; v_norm = f2 * s2 / safe_s3 + 0.5 + dv
    elseif optmod == 2
        theta = atan(radial, s3); r = sin(radial_alpha * theta)
        u_norm = f1 * s1 / radial * r + 0.5 + du; v_norm = f2 * s2 / radial * r + 0.5 + dv
    elseif optmod == 3
        theta = atan(radial, s3); safe_s3 = max(s3, 1e-12)
        u_norm = f1 * (1.0 - radial_alpha) * s1 / safe_s3 + f1 * radial_alpha * s1 / radial * theta + 0.5 + du
        v_norm = f2 * (1.0 - radial_alpha) * s2 / safe_s3 + f2 * radial_alpha * s2 / radial * theta + 0.5 + dv
    elseif optmod == 4
        theta = atan(radial, s3); r = abs(theta) ^ radial_alpha
        u_norm = f1 * s1 / radial * r + 0.5 + du; v_norm = f2 * s2 / radial * r + 0.5 + dv
    elseif optmod == 5
        theta = atan(radial, s3); r = tan(radial_alpha * theta)
        u_norm = f1 * s1 / radial * r + 0.5 + du; v_norm = f2 * s2 / radial * r + 0.5 + dv
    elseif optmod == 12
        theta = atan(radial, s3)
        r = radial_alpha > 0 ? tan(radial_alpha * theta) / radial_alpha :
            radial_alpha < 0 ? sin(radial_alpha * theta) / radial_alpha : abs(theta)
        u_norm = f1 * s1 / radial * r + 0.5 + du; v_norm = f2 * s2 / radial * r + 0.5 + dv
    elseif optmod == ${BROWN_CONRADY_OPTMOD}
        safe_s3 = abs(s3) > 1e-12 ? s3 : 1e-12
        xn = s1 / safe_s3; yn = s2 / safe_s3
        r2 = xn*xn + yn*yn; r4 = r2*r2; r6 = r4*r2
        k1 = optpar[8]; k2 = optpar[9]; k3 = optpar[10]; p1 = optpar[11]; p2 = optpar[12]
        L = 1.0 + k1*r2 + k2*r4 + k3*r6
        xd = xn*L + 2.0*p1*xn*yn + p2*(r2 + 2.0*xn*xn)
        yd = yn*L + p1*(r2 + 2.0*yn*yn) + 2.0*p2*xn*yn
        u_norm = f1 * xd + 0.5 + du; v_norm = f2 * yd + 0.5 + dv
    else
        error("unsupported optmod")
    end
    return (u_norm * width - 1.0, v_norm * height - 1.0)
end
`;
    }

    function cMapperCode(context) {
        return `${header(context, "c")}#include <math.h>
${optparArrayText(context, "c")}
static const int optmod = ${Math.round(Number(context.optmod) || 0)};
static const double *op = optpar + 1;
static const double image_width = ${numberText(context.width)};
static const double image_height = ${numberText(context.height)};

static void camera_rot(double alpha_deg, double beta_deg, double gamma_deg, double rot[9]) {
    double a = alpha_deg * M_PI / 180.0, b = beta_deg * M_PI / 180.0, g = gamma_deg * M_PI / 180.0;
    double rot1[9] = {cos(g), -sin(g), 0, sin(g), cos(g), 0, 0, 0, 1};
    double rot2[9] = {cos(a), 0, sin(a), 0, 1, 0, -sin(a), 0, cos(a)};
    double rot3[9] = {1, 0, 0, 0, cos(b), sin(b), 0, -sin(b), cos(b)};
    double tmp[9];
    for (int r = 0; r < 3; r++) for (int c = 0; c < 3; c++) tmp[3*r+c] = rot2[3*r+0]*rot3[c] + rot2[3*r+1]*rot3[3+c] + rot2[3*r+2]*rot3[6+c];
    for (int r = 0; r < 3; r++) for (int c = 0; c < 3; c++) rot[3*r+c] = tmp[3*r+0]*rot1[c] + tmp[3*r+1]*rot1[3+c] + tmp[3*r+2]*rot1[6+c];
}

void aida_az_el_to_image(double az_deg, double el_deg, double *x, double *y) {
    double rot[9]; camera_rot(op[2], op[3], op[4], rot);
    double az = az_deg * M_PI / 180.0, ze = (90.0 - el_deg) * M_PI / 180.0;
    double sinze = sin(ze);
    double es1 = sinze * sin(az), es2 = sinze * cos(az), es3 = cos(ze);
    double s1 = es1*rot[0] + es2*rot[3] + es3*rot[6];
    double s2 = es1*rot[1] + es2*rot[4] + es3*rot[7];
    double s3 = es1*rot[2] + es2*rot[5] + es3*rot[8];
    double f1 = op[0], f2 = op[1], du = op[5], dv = op[6], radial_alpha = op[7];
    double radial = hypot(s1, s2), u_norm, v_norm;
    if (radial <= 1e-12) { u_norm = 0.5 + du; v_norm = 0.5 + dv; }
    else if (optmod == 1) { double ss3 = fabs(s3) > 1e-12 ? s3 : 1e-12; u_norm = f1*s1/ss3 + 0.5 + du; v_norm = f2*s2/ss3 + 0.5 + dv; }
    else if (optmod == 2) { double theta = atan2(radial, s3), rr = sin(radial_alpha*theta); u_norm = f1*s1/radial*rr + 0.5 + du; v_norm = f2*s2/radial*rr + 0.5 + dv; }
    else if (optmod == 3) { double theta = atan2(radial, s3), ss3 = fmax(s3, 1e-12); u_norm = f1*(1.0-radial_alpha)*s1/ss3 + f1*radial_alpha*s1/radial*theta + 0.5 + du; v_norm = f2*(1.0-radial_alpha)*s2/ss3 + f2*radial_alpha*s2/radial*theta + 0.5 + dv; }
    else if (optmod == 4) { double theta = atan2(radial, s3), rr = pow(fabs(theta), radial_alpha); u_norm = f1*s1/radial*rr + 0.5 + du; v_norm = f2*s2/radial*rr + 0.5 + dv; }
    else if (optmod == 5) { double theta = atan2(radial, s3), rr = tan(radial_alpha*theta); u_norm = f1*s1/radial*rr + 0.5 + du; v_norm = f2*s2/radial*rr + 0.5 + dv; }
    else if (optmod == 12) { double theta = atan2(radial, s3), rr = radial_alpha > 0 ? tan(radial_alpha*theta)/radial_alpha : (radial_alpha < 0 ? sin(radial_alpha*theta)/radial_alpha : fabs(theta)); u_norm = f1*s1/radial*rr + 0.5 + du; v_norm = f2*s2/radial*rr + 0.5 + dv; }
    else {
        double ss3 = fabs(s3) > 1e-12 ? s3 : 1e-12, xn = s1/ss3, yn = s2/ss3;
        double r2 = xn*xn + yn*yn, r4 = r2*r2, r6 = r4*r2;
        double k1 = op[7], k2 = op[8], k3 = op[9], p1 = op[10], p2 = op[11];
        double L = 1.0 + k1*r2 + k2*r4 + k3*r6;
        double xd = xn*L + 2.0*p1*xn*yn + p2*(r2 + 2.0*xn*xn);
        double yd = yn*L + p1*(r2 + 2.0*yn*yn) + 2.0*p2*xn*yn;
        u_norm = f1*xd + 0.5 + du; v_norm = f2*yd + 0.5 + dv;
    }
    *x = u_norm * image_width - 1.0; *y = v_norm * image_height - 1.0;
}
`;
    }

    function matlabMapperCode(context) {
        return `${header(context, "matlab")}${optparArrayText(context, "matlab")}
optmod = round(optpar(1));
optpar = optpar(2:end);
image_width = ${context.width};
image_height = ${context.height};

function [x, y] = az_el_to_image(az_deg, el_deg, optpar, optmod, width, height)
if nargin < 3, optpar = evalin('base','optpar'); end
if nargin < 4, optmod = evalin('base','optmod'); end
if nargin < 5, width = evalin('base','image_width'); height = evalin('base','image_height'); end
a=deg2rad(optpar(3)); b=deg2rad(optpar(4)); g=deg2rad(optpar(5));
rot1=[cos(g) -sin(g) 0; sin(g) cos(g) 0; 0 0 1];
rot2=[cos(a) 0 sin(a); 0 1 0; -sin(a) 0 cos(a)];
rot3=[1 0 0; 0 cos(b) sin(b); 0 -sin(b) cos(b)];
rot=rot2*rot3*rot1;
az=deg2rad(az_deg); ze=deg2rad(90-el_deg); sinze=sin(ze);
es=[sinze*sin(az), sinze*cos(az), cos(ze)];
s=es*rot; s1=s(1); s2=s(2); s3=s(3); radial=hypot(s1,s2);
f1=optpar(1); f2=optpar(2); du=optpar(6); dv=optpar(7); ar=optpar(8);
if radial <= 1e-12
    u=0.5+du; v=0.5+dv;
elseif optmod == 1
    ss3=max(abs(s3),1e-12)*sign(s3 + (s3==0)); u=f1*s1/ss3+0.5+du; v=f2*s2/ss3+0.5+dv;
elseif optmod == 2
    theta=atan2(radial,s3); rr=sin(ar*theta); u=f1*s1/radial*rr+0.5+du; v=f2*s2/radial*rr+0.5+dv;
elseif optmod == 3
    theta=atan2(radial,s3); ss3=max(s3,1e-12); u=f1*(1-ar)*s1/ss3+f1*ar*s1/radial*theta+0.5+du; v=f2*(1-ar)*s2/ss3+f2*ar*s2/radial*theta+0.5+dv;
elseif optmod == 4
    theta=atan2(radial,s3); rr=abs(theta)^ar; u=f1*s1/radial*rr+0.5+du; v=f2*s2/radial*rr+0.5+dv;
elseif optmod == 5
    theta=atan2(radial,s3); rr=tan(ar*theta); u=f1*s1/radial*rr+0.5+du; v=f2*s2/radial*rr+0.5+dv;
elseif optmod == 12
    theta=atan2(radial,s3); if ar>0, rr=tan(ar*theta)/ar; elseif ar<0, rr=sin(ar*theta)/ar; else, rr=abs(theta); end
    u=f1*s1/radial*rr+0.5+du; v=f2*s2/radial*rr+0.5+dv;
else
    ss3=max(abs(s3),1e-12)*sign(s3 + (s3==0)); xn=s1/ss3; yn=s2/ss3; r2=xn*xn+yn*yn; r4=r2*r2; r6=r4*r2;
    k1=optpar(8); k2=optpar(9); k3=optpar(10); p1=optpar(11); p2=optpar(12);
    L=1+k1*r2+k2*r4+k3*r6; xd=xn*L+2*p1*xn*yn+p2*(r2+2*xn*xn); yd=yn*L+p1*(r2+2*yn*yn)+2*p2*xn*yn;
    u=f1*xd+0.5+du; v=f2*yd+0.5+dv;
end
x=u*width-1; y=v*height-1;
end
`;
    }

    function mapperCode(context, language = "python") {
        if (language === "julia") {
            return juliaMapperCode(context);
        }
        if (language === "c") {
            return cMapperCode(context);
        }
        if (language === "matlab") {
            return matlabMapperCode(context);
        }
        return pythonMapperCode(context);
    }

    window.AidaExportGenerators = {
        BROWN_CONRADY_OPTMOD,
        numberText,
        optparArrayText,
        mapperCode,
    };
})();
