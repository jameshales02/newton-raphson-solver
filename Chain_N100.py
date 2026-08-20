#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Fri Jan  9 11:36:38 2026

@author: jameshales
"""

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Fri Jan  9 11:28:26 2026

@author: jameshales
"""

# -*- coding: utf-8 -*-
"""
Created on Mon Nov 10 12:58:55 2025

@author: 15hal
"""

import numpy as np
from newton_solve import newton_solve
import math

# -----------------------------
# Problem setup (you can tweak)
# -----------------------------
A = np.array([0.0, 0.0])      # left support r0
B = np.array([1.0, 0.0])      # right support rN
L = np.linalg.norm(B - A)     # horizontal span
N = 320                       # number of links

total_length = 1.20 * L       # total chain length (> L)
s = total_length / N          # each link length
W = 1.0                       # weight per interior node (same convention as your 4-link script)

# -----------------------------
# Utilities
# -----------------------------
def unpack_vars(v):
    """
    v = [x1,y1, x2,y2, ..., x_{N-1},y_{N-1},  T0,T1,...,T_{N-1}]
    -> positions r0..rN and tensions T0..T_{N-1}
    """
    npos = 2*(N-1)             # 2 coords for each interior node
    coords = v[:npos]
    T = v[npos:]

    # Build node list r0..rN
    r = [A]
    for k in range(N-1):
        xk = coords[2*k]
        yk = coords[2*k + 1]
        r.append(np.array([xk, yk], dtype=float))
    r.append(B)

    return tuple(r), np.array(T, dtype=float)

def unit(vec):
    n = np.linalg.norm(vec)
    if n == 0.0:
        return np.array([0.0, 0.0]), 0.0
    return vec/n, n

# -----------------------------
# Residual function F(v)
# -----------------------------
def F(v):
    r, T = unpack_vars(v)   # r = (r0, r1, ..., rN), T = (T0, ..., T_{N-1})

    # Link unit directions and lengths
    e = []
    Lk = []
    for k in range(N):
        ek, lk = unit(r[k+1] - r[k])
        e.append(ek)
        Lk.append(lk)

    # Length constraints: ||r_{k+1} - r_k|| - s = 0 for k=0..N-1
    c_len = [Lk[k] - s for k in range(N)]

    # Force balance at interior nodes j=1..N-1:
    # T_{j-1} * e_{j-1} - T_j * e_j + (0, -W) = 0
    c_fb = []
    for j in range(1, N):
        fb = T[j-1]*e[j-1] - T[j]*e[j] + np.array([0.0, -W])
        c_fb.extend([fb[0], fb[1]])

    # Stack: N length + (N-1)*2 force = N + 2(N-1) = 3N - 2 equations
    # Unknowns: 2(N-1) positions + N tensions = 3N - 2 unknowns (square system)
    return np.array(c_len + c_fb, dtype=float)

# -----------------------------
# Initial guess builder
# -----------------------------
def initial_guess():
    # Even x spacing with a gentle sag (same shape you used)
    x_lin = np.linspace(A[0], B[0], N+1)
    y_lin = np.linspace(A[1], B[1], N+1)

    sag = 0.1 * L
    x_int = x_lin[1:-1]
    y_lin[1:-1] -= sag * ((x_int - A[0]) * (B[0] - x_int)) / (0.25*L*L + 1e-12)

    # Pack interior node coords
    coords = []
    for k in range(1, N):
        coords.extend([x_lin[k], y_lin[k]])

    # Initial tensions
    T0 = [1.0]*N

    return np.array(coords + T0, dtype=float)

# -----------------------------
# Solve
# -----------------------------
x0 = initial_guess()
sol, info = newton_solve(F, x0, J=None, tol=1e-10, max_iter=200, damping=True)

print("Success:", info["success"], "  iters:", info["iterations"], "  ||F||:", info["residual"])
r, T = unpack_vars(sol)

print("Nodes:")
for i, ri in enumerate(r):
    print(f"r{i} =", ri)

print("Tensions:", T)

# -----------------------------
# (Optional) plot the chain
# -----------------------------
try:
    import matplotlib.pyplot as plt
    X = [ri[0] for ri in r]
    Y = [ri[1] for ri in r]
    plt.figure()
    plt.plot(X, Y, marker='o')
    for i, (xi, yi) in enumerate(zip(X, Y)):
        plt.text(xi, yi, f"P{i}", ha='right', va='bottom')
    plt.axis('equal'); plt.grid(True)
    plt.title(f"Discrete Hanging Chain ({N} links)")
    plt.xlabel("x"); plt.ylabel("y")
    plt.show()
except Exception as e:
    print("Plot skipped:", e)
