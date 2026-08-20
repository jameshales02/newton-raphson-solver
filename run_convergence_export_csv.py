

import numpy as np
import pandas as pd
from newton_solve import newton_solve



A = np.array([0.0, 0.0])        # left support
B = np.array([1.0, 0.0])        # right support
L = float(np.linalg.norm(B - A))

N_list = [3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 35, 50, 75, 100, 200]   # convergence study Ns

S_ratio = 1.20                  # total_length = S_ratio * L
tol = 1e-10
max_iter = 200
damping = True


W_total = 1.0                   



def unit(vec: np.ndarray):
    n = float(np.linalg.norm(vec))
    if n == 0.0:
        return np.array([0.0, 0.0]), 0.0
    return vec / n, n


def unpack_vars(v: np.ndarray, N: int, A: np.ndarray, B: np.ndarray):
    """
    v = [x1,y1, ..., x_{N-1},y_{N-1},  T0,...,T_{N-1}]
    returns:
      r: tuple of nodes (r0..rN) each in R^2
      T: ndarray of tensions (T0..T_{N-1})
    """
    npos = 2 * (N - 1)
    coords = v[:npos]
    T = v[npos:]

    r = [A]
    for k in range(N - 1):
        r.append(np.array([coords[2 * k], coords[2 * k + 1]], dtype=float))
    r.append(B)

    return tuple(r), np.array(T, dtype=float)


def build_F(N: int, A: np.ndarray, B: np.ndarray, s: float, W_node: float):
    """
    Returns residual function F(v) for given N, supports, link length s, and nodal weight W_node.
    """
    def F(v: np.ndarray):
        r, T = unpack_vars(v, N, A, B)

        # Link unit directions and lengths
        e = []
        Lk = []
        for k in range(N):
            ek, lk = unit(r[k + 1] - r[k])
            e.append(ek)
            Lk.append(lk)

        # Length constraints: ||r_{k+1} - r_k|| - s = 0
        c_len = [Lk[k] - s for k in range(N)]

        # Force balance at interior nodes j = 1..N-1:
        # T_{j-1} e_{j-1} - T_j e_j + (0, -W_node) = 0
        c_fb = []
        for j in range(1, N):
            fb = T[j - 1] * e[j - 1] - T[j] * e[j] + np.array([0.0, -W_node])
            c_fb.extend([fb[0], fb[1]])

        return np.array(c_len + c_fb, dtype=float)

    return F


def initial_guess(N: int, A: np.ndarray, B: np.ndarray, L: float):

    x_lin = np.linspace(A[0], B[0], N + 1)
    y_lin = np.linspace(A[1], B[1], N + 1)

    sag = 0.1 * L
    x_int = x_lin[1:-1]
    y_lin[1:-1] -= sag * ((x_int - A[0]) * (B[0] - x_int)) / (0.25 * L * L + 1e-12)

    coords = []
    for k in range(1, N):
        coords.extend([x_lin[k], y_lin[k]])

    T0 = [1.0] * N
    return np.array(coords + T0, dtype=float)


def solve_catenary_a_from_length(L: float, S: float, max_iter: int = 200, tol: float = 1e-14):

    if S < L:
        raise ValueError(f"Total length S={S} is less than span L={L}. No hanging solution exists.")

    def f(a: float) -> float:
        return 2.0 * a * np.sinh(L / (2.0 * a)) - S

    # Bracket root:
    a_low = 1e-12
    a_high = 1.0
    while f(a_high) > 0.0:
        a_high *= 2.0
        if a_high > 1e12:
            raise RuntimeError("Failed to bracket catenary parameter 'a'. Check inputs.")

    # Bisection
    for _ in range(max_iter):
        a_mid = 0.5 * (a_low + a_high)
        fm = f(a_mid)
        if abs(fm) < tol:
            return a_mid
        if fm > 0.0:
            a_low = a_mid
        else:
            a_high = a_mid
    return 0.5 * (a_low + a_high)


def y_catenary(x: np.ndarray, L: float, a: float):
    """
    Symmetric catenary with endpoints at y=0 located at x=0 and x=L:
      y(x) = a cosh((x - L/2)/a) - a cosh((L/2)/a)
    """
    return a * np.cosh((x - 0.5 * L) / a) - a * np.cosh((0.5 * L) / a)



summary_rows = []
node_rows = []

S_total = S_ratio * L  # keep geometry fixed across N

for N in N_list:
    s = S_total / N

    # Keep total weight fixed across N by distributing over (N-1) interior nodes
    W_node = W_total / (N - 1)

    F = build_F(N, A, B, s, W_node)
    x0 = initial_guess(N, A, B, L)

    sol, info = newton_solve(F, x0, J=None, tol=tol, max_iter=max_iter, damping=damping)
    r, T = unpack_vars(sol, N, A, B)

    X = np.array([ri[0] for ri in r], dtype=float)
    Y = np.array([ri[1] for ri in r], dtype=float)

    # Continuous reference (geometry matched by L and S_total)
    a = solve_catenary_a_from_length(L=L, S=S_total)
    Ycat = y_catenary(X, L=L, a=a)

    # Per-node error
    e = Y - Ycat
    abs_e = np.abs(e)

    # Interior nodes only for norms
    e_int = e[1:-1]
    E_inf = float(np.max(np.abs(e_int))) if len(e_int) else 0.0
    E2 = float(np.sqrt(np.mean(e_int ** 2))) if len(e_int) else 0.0

    max_sag_discrete = float(-np.min(Y))
    max_sag_catenary = float(-np.min(Ycat))

    summary_rows.append({
        "N": N,
        "L": L,
        "S_total": S_total,
        "link_length_s": s,
        "W_total": W_total,
        "W_node": W_node,
        "num_nodes": N + 1,
        "num_unknowns": 3 * N - 2,
        "iters": int(info.get("iterations", -1)),
        "residual_norm": float(info.get("residual", np.nan)),
        "success": bool(info.get("success", False)),
        "max_sag_discrete": max_sag_discrete,
        "max_sag_catenary": max_sag_catenary,
        "E_inf": E_inf,
        "E2": E2,
        "catenary_a": float(a),
    })

    for i in range(N + 1):
        node_rows.append({
            "N": N,
            "node_index": i,
            "x_i": float(X[i]),
            "y_i": float(Y[i]),
            "y_catenary": float(Ycat[i]),
            "e_i": float(e[i]),
            "abs_e_i": float(abs_e[i]),
            "is_support": int(i == 0 or i == N),
        })

# DataFrames + save to CSV
summary_df = pd.DataFrame(summary_rows).sort_values("N").reset_index(drop=True)
nodes_df = pd.DataFrame(node_rows).sort_values(["N", "node_index"]).reset_index(drop=True)

summary_df.to_csv("summary.csv", index=False)
nodes_df.to_csv("nodes.csv", index=False)

print("Done. Wrote: summary.csv and nodes.csv")
print(summary_df[["N", "success", "iters", "residual_norm", "E_inf", "E2"]])
