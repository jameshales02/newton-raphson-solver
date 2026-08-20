# -*- coding: utf-8 -*-
"""
Created on Mon Nov 10 14:00:25 2025

@author: 15hal
"""

# test_chain5.py
# --------------------------------------------
# Discrete hanging chain with 5 links (fixed ends, 4 interior nodes).
# Unknowns: (x1,y1, x2,y2, x3,y3, x4,y4, T0,T1,T2,T3,T4) -> 13 vars
# Equations: 5 length constraints + 4*2 force balances = 13

import numpy as np
from newton_solve import newton_solve

# -----------------------------
# Problem setup (tweak as you like)
# -----------------------------
A = np.array([0.0, 0.0])      # left support (fixed)
B = np.array([1.0, 0.0])      # right support (fixed)
N = 5                         # number of links
assert N == 5                 # this script is for 5 links / 4 interior nodes

Lspan = np.linalg.norm(B - A)
total_length = 1.25 * Lspan   # total chain length (> span)
s = total_length / N          # link length
W = 1.0                       # weight per link (sets sag scale)

# -----------------------------
# Helpers
# -----------------------------
def unit(vec):
    n = np.linalg.norm(vec)
    if n == 0.0:
        return np.array([0.0, 0.0]), 0.0
    return vec / n, n

def unpack_vars(v):
    """
    v = [x1,y1, x2,y2, x3,y3, x4,y4, T0,T1,T2,T3,T4]
    Returns list of node positions r[0..N] and tensions T[0..N-1]
    """
    m = N - 1  # number of interior nodes (4)
    xy = np.array(v[:2*m]).reshape(m, 2)
    T = np.array(v[2*m:2*m+N], dtype=float)
    r = [None] * (N + 1)
    r[0] = A
    r[1:m+1] = [xy[i] for i in range(m)]
    r[N] = B
    return r, T

# -----------------------------
# Residuals
# -----------------------------
def F(v):
    r, T = unpack_vars(v)

    # Unit directions and lengths for each link i=0..N-1
    e = [None] * N
    L = np.zeros(N)
    for i in range(N):
        e[i], L[i] = unit(r[i+1] - r[i])

    # Length constraints: ||r_{i+1} - r_i|| - s = 0
    c_len = L - s  # shape (N,)

    # Force balance at interior nodes j=1..N-1:
    # T_{j-1} e_{j-1} - T_j e_j + (0, -W) = 0
    fb = []
    for j in range(1, N):
        fb_vec = T[j-1]*e[j-1] - T[j]*e[j] + np.array([0.0, -W])
        fb.extend(fb_vec.tolist())

    # Stack residuals: N length + 2*(N-1) force = N + 2N - 2 = 3N - 2 = 13
    return np.hstack([c_len, fb]).astype(float)

# -----------------------------
# Initial guess
# -----------------------------
def initial_guess():
    # Even spacing between A and B, with gentle parabolic sag
    xs = np.linspace(A[0], B[0], N+1)
    ys = np.linspace(A[1], B[1], N+1)
    # add sag to interior nodes (parabolic bump)
    sag = 0.12 * Lspan
    center = 0.5*(A[0] + B[0])
    width2 = (0.5*Lspan)**2 + 1e-12
    for j in range(1, N):  # interior nodes only
        ys[j] -= sag * (1.0 - ((xs[j] - center)**2) / width2)

    # unknown vector = interior nodes then tensions
    xy_interior = np.vstack([ [xs[j], ys[j]] for j in range(1, N) ])  # shape (4,2)
    T0 = np.full(N, 1.0)  # reasonable starting tensions
    return np.hstack([xy_interior.ravel(), T0]).astype(float)

# -----------------------------
# Solve
# -----------------------------
x0 = initial_guess()
sol, info = newton_solve(F, x0, J=None, tol=1e-10, max_iter=300, damping=True)

print("Success:", info["success"], "  iters:", info["iterations"], "  ||F||:", info["residual"])

# Unpack solution
r, T = unpack_vars(sol)
for i, ri in enumerate(r):
    print(f"r{i} = [{ri[0]:.6f}, {ri[1]:.6f}]")
print("Tensions:", np.array2string(T, precision=6, floatmode='fixed'))

# Check link lengths
lengths = [np.linalg.norm(r[i+1]-r[i]) for i in range(N)]
print("Link lengths:", np.array2string(np.array(lengths), precision=6, floatmode='fixed'))

# -----------------------------
# Plot
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
    plt.title("Discrete Hanging Chain (5 links, 4 interior nodes)")
    plt.xlabel("x"); plt.ylabel("y (down negative)")
    plt.show()
except Exception as e:
    print("Plot skipped:", e)
